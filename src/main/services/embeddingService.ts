/**
 * Local Embedding Service
 *
 * Provides local embedding generation using transformers.js with the BGE-small-en-v1.5 model.
 * Runs entirely on-device with no API calls required.
 *
 * BGE models are optimized for retrieval tasks. For best results:
 * - Documents: embed as plain text (no prefix)
 * - Queries: use generateQueryEmbedding() which adds the recommended prefix
 *
 * ARCHITECTURE:
 * - GPU Backend (preferred): Uses Hidden BrowserWindow with WebGPU for faster embeddings
 * - CPU Backend (fallback): Uses utilityProcess for isolation of native module crashes
 *
 * Backend selection happens at initialization:
 * 1. If gpuEmbeddingEnabled === false in settings, use CPU
 * 2. Try GPU backend initialization
 * 3. If GPU not available or fails, fall back to CPU
 *
 * IMPORTANT: GPU and CPU backends are completely separate implementations.
 * We do NOT hot-swap between them during runtime to prevent race conditions.
 */

import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { logger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { GpuEmbeddingBackend } from './gpuEmbeddingBackend';
import { isShuttingDown, ShutdownError } from './shutdownState';
import {
  createBackgroundConsumerLatch,
  type BackgroundConsumerLatch,
} from './visibilityAwareScheduler';
import type { AppSettings } from '@shared/types';
import { EMBEDDING_DIMENSION, type CallerIntent } from '@core/embeddingGenerator';
import { fireAndForget } from '@shared/utils/fireAndForget';
export type { CallerIntent } from '@core/embeddingGenerator';

// SSOT: the expected embedding dimension lives in `@core/embeddingGenerator`
// (electron-free) so the fileIndexService guard can validate against it without
// importing this electron-bound module. Keep this alias for local readability.
const EMBEDDING_DIMS = EMBEDDING_DIMENSION;
const MODEL_LOAD_DELAY_MS = 1000; // Reduced from 3000ms - worker doesn't block UI
const PRIORITY_REQUEST_TIMEOUT_MS = 8000; // 8s timeout for priority requests (user-facing queries)
const BATCH_REQUEST_TIMEOUT_MS = 15000; // 15s timeout for batch requests (background indexing)
const INIT_TIMEOUT_MS = 90000; // 90s timeout for model initialization (handles slow machines)
const MAX_INIT_RETRIES = 5; // Retry aggressively before degrading embedding-dependent features
const INIT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000]; // Shorter initial backoff for transient model-load failures
const RETRY_COOLDOWN_MS = 5000; // 5s cooldown for init failures (keeps auto-recovery responsive without retry storms)
const CRASH_COOLDOWN_MS = 5000; // 5s cooldown for runtime crashes (allows faster recovery)

// Stage 6 (260508): pause background embedding work on active-turn signal.
// Lazy-init latch shared across batch / background-indexing callers; honoured
// by both `generateEmbedding(text, 'background_indexing')` and
// `generateEmbeddings(texts)`. Defaults on; opt-out via
// REBEL_EMBEDDER_PAUSE_ON_ACTIVE_TURN=0.
const EMBEDDER_PAUSE_ON_ACTIVE_TURN =
  (process.env.REBEL_EMBEDDER_PAUSE_ON_ACTIVE_TURN ?? '1') === '1';
const EMBEDDER_MAX_PAUSE_MS_DEFAULT = 30 * 60 * 1000;
let backgroundEmbedLatch: BackgroundConsumerLatch | null = null;

/**
 * Embedder turn-active pause counters mirror the file-watcher's
 * `IndexerStats` parity per Stage 6 Phase 6 (260508). Session-scoped:
 * reset on `_resetBackgroundEmbedLatchForTesting()` and on test resets.
 *
 * Phase 8 deferral note: `embedding-worker PID CPU` and `resume latency`
 * (in real wall-clock terms, not test-time terms) are NOT exposed here —
 * they require live-process measurement against a fresh baseline (Stage 0
 * Phase G) and are not unit-testable. The four counters in `IndexerStats`
 * + `EmbedderTurnActiveStats` cover what the test harness CAN observe.
 */
export interface EmbedderTurnActiveStats {
  turnActivePauseCount: number;
  turnActivePauseTotalMs: number;
  degradedModeEntryCount: number;
}

const embedderTurnActiveStats: EmbedderTurnActiveStats = {
  turnActivePauseCount: 0,
  turnActivePauseTotalMs: 0,
  degradedModeEntryCount: 0,
};

function normalizeCallerIntent(callerIntent: CallerIntent | boolean | undefined): CallerIntent {
  if (callerIntent === true) return 'user_query';
  if (callerIntent === false || callerIntent === undefined) return 'background_indexing';
  return callerIntent;
}

function usesPriorityQueue(callerIntent: CallerIntent): boolean {
  return callerIntent === 'user_query';
}

function getBackgroundEmbedLatch(): BackgroundConsumerLatch | null {
  if (!EMBEDDER_PAUSE_ON_ACTIVE_TURN) return null;
  if (backgroundEmbedLatch) return backgroundEmbedLatch;
  const rawMaxPauseMs = Number.parseInt(process.env.REBEL_INDEXER_MAX_PAUSE_MS ?? '', 10);
  const watchdogTimeoutMs = Number.isFinite(rawMaxPauseMs) && rawMaxPauseMs > 0
    ? rawMaxPauseMs
    : EMBEDDER_MAX_PAUSE_MS_DEFAULT;
  backgroundEmbedLatch = createBackgroundConsumerLatch('embeddingService', {
    watchdogTimeoutMs,
  });
  return backgroundEmbedLatch;
}

async function awaitBackgroundEmbedGate(): Promise<void> {
  const latch = getBackgroundEmbedLatch();
  if (!latch) return;
  if (!latch.shouldDeferForTurnActive()) return;
  const pauseStartedAt = latch.getPausedSinceMs() ?? Date.now();
  embedderTurnActiveStats.turnActivePauseCount++;
  const result = await latch.waitUntilResumeOrDegraded();
  embedderTurnActiveStats.turnActivePauseTotalMs += Date.now() - pauseStartedAt;
  if (result.outcome === 'degraded') {
    const degradedReason = result.reason;
    const degradedMessage = degradedReason === 'leaked_active_turn_signal'
      ? 'Embedder degraded mode entered due leaked active-turn signal while gating background work'
      : 'Embedder degraded mode entered due stuck active-turn signal while gating background work';
    embedderTurnActiveStats.degradedModeEntryCount++;
    logger.warn(
      {
        watchdogTimeoutMs: EMBEDDER_MAX_PAUSE_MS_DEFAULT,
        reason: degradedReason,
      },
      degradedMessage,
    );
  }
}

/**
 * Snapshot of embedder turn-active counters for telemetry / diagnostics.
 * Mirrors `getIndexerStats()` for the file-watcher; values returned by copy.
 */
export function getEmbedderTurnActiveStats(): EmbedderTurnActiveStats {
  return { ...embedderTurnActiveStats };
}

/**
 * Test-only — drop the lazy embedder latch so subsequent callers re-init on
 * the next gate check. Used by `_resetForTesting` analogues in unit tests.
 */
export function _resetBackgroundEmbedLatchForTesting(): void {
  if (backgroundEmbedLatch) {
    backgroundEmbedLatch.dispose();
    backgroundEmbedLatch = null;
  }
  embedderTurnActiveStats.turnActivePauseCount = 0;
  embedderTurnActiveStats.turnActivePauseTotalMs = 0;
  embedderTurnActiveStats.degradedModeEntryCount = 0;
}

// Prevents OOM in embedding worker - see docs/plans/finished/260128_embedding-batch-size-limit.md
// Reduced from 32 to 16 after REBEL-KK OOM continued on some systems (tensor disposal + smaller batches)
const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
const parsedBatchSize = process.env.REBEL_EMBEDDING_BATCH_SIZE
  ? parseInt(process.env.REBEL_EMBEDDING_BATCH_SIZE, 10)
  : DEFAULT_EMBEDDING_BATCH_SIZE;
const MAX_EMBEDDING_BATCH_SIZE = parsedBatchSize > 0 ? parsedBatchSize : DEFAULT_EMBEDDING_BATCH_SIZE;

// Circuit breaker for model corruption auto-recovery
// Limits delete/redownload cycles per session to prevent infinite loops on persistent issues
const MAX_CORRUPTION_RECOVERIES_PER_SESSION = 2;

// CPU idle disposal — reclaim ~350-400 MB RAM (worker RSS, per historical logs) when CPU worker is unused.
// See docs/plans/260422_embedding_cpu_storm_and_blur_gpu_churn.md § Stage 3.
//
// Gating: env `REBEL_CPU_IDLE_DISPOSAL=1` continues to win as an override (e.g.
// for ops/debug). Otherwise the runtime-effective value is driven by
// `settings.cpuEmbeddingIdleDisposalEnabled`, which Efficiency Mode flips to
// true (see docs/plans/260524_performance_mode.md). The flag is mutated via
// `applyEmbeddingBackendFromSettings` whenever settings change.
const CPU_IDLE_DISPOSAL_ENV_OVERRIDE = process.env.REBEL_CPU_IDLE_DISPOSAL === '1';
let cpuIdleDisposalEnabled = CPU_IDLE_DISPOSAL_ENV_OVERRIDE;

function isCpuIdleDisposalEnabled(): boolean {
  return cpuIdleDisposalEnabled;
}

/**
 * Update the CPU idle disposal flag from current settings. The env var
 * `REBEL_CPU_IDLE_DISPOSAL=1` always wins. Returns the new effective value.
 */
function updateCpuIdleDisposalFromSettings(settings: AppSettings | undefined): boolean {
  const next = CPU_IDLE_DISPOSAL_ENV_OVERRIDE
    || settings?.cpuEmbeddingIdleDisposalEnabled === true;
  if (next !== cpuIdleDisposalEnabled) {
    cpuIdleDisposalEnabled = next;
    logger.info(
      { cpuIdleDisposalEnabled, source: CPU_IDLE_DISPOSAL_ENV_OVERRIDE ? 'env-override' : 'settings' },
      'CPU embedding idle disposal flag updated',
    );
  }
  return cpuIdleDisposalEnabled;
}
let CPU_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (let for test override)
const CPU_IDLE_DISPOSE_HANDSHAKE_TIMEOUT_MS = 5000; // 5s timeout for dispose handshake
let embeddingInitFailureReportedThisBoot = false;

/** Default ONNX intraOp thread cap for the embedding worker.
 *  Set via session_options.intraOpNumThreads; also applied to non-Windows hosts
 *  where the historical OMP_NUM_THREADS env var is a no-op for ORT 1.7+ (no OpenMP build).
 *  Rationale & benchmarks: docs/plans/260422_embedding_cpu_storm_and_blur_gpu_churn.md § Stage 2. */
const DESKTOP_ONNX_INTRA_OP_THREADS_DEFAULT = 4;

// Historical Windows-only OMP fallback for older ORT/OpenMP builds.
// The cross-platform ONNX thread cap now comes from resolveIntraOpThreads() via intraOpNumThreads.
// WINDOWS_ONNX_THREAD_LIMIT removed in Stage 2 — attemptWorkerInit now mirrors resolveIntraOpThreads()
// for OMP_NUM_THREADS so Windows env fallback stays consistent with the ORT session_options cap.

export function resolveIntraOpThreads(): number {
  const raw = process.env.REBEL_ONNX_INTRA_OP_THREADS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 16) return parsed;
    logger.warn({ raw }, 'Invalid REBEL_ONNX_INTRA_OP_THREADS; using host-scaled default');
  }

  // Defensive floor for low-core hosts (4-core Intel Macs, CI 2-core sandboxes, 1-core hosts).
  // Leave at least 1 core for main process / OS.
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(DESKTOP_ONNX_INTRA_OP_THREADS_DEFAULT, cores - 1));
}

export type CpuWorkerInitReason =
  | 'startup'
  | 'blur-fallback'
  | 'idle-fallback'
  | 'gpu-error-fallback'
  | 'manual';

function reportEmbeddingInitFailureOnce(
  error: Error,
  context: { attempts: number; initReason: CpuWorkerInitReason; modelCacheDir?: string },
): void {
  if (embeddingInitFailureReportedThisBoot) return;
  embeddingInitFailureReportedThisBoot = true;

  try {
    getErrorReporter().captureException(error, {
      level: 'warning',
      tags: {
        area: 'embedding-service',
        component: 'cpu-worker',
        failure: 'initialization',
      },
      extra: context,
    });
  } catch (err) {
    // Wave 2d (W2D-6) sentinel: re-throw KnownConditionGuardError so the
    // Wave 2c deterministic-CI-failure contract (KNOWN_CONDITION_GUARD_LEVEL=throw
    // in NODE_ENV=test) survives this fail-safe wrapper. Production behaviour
    // is unchanged (env-knob unset → warn; throw-mode outside test → warn).
    // See docs/plans/260503_wave2d_layer2_contract_completion.md (Wave 2d).
    if (
      process.env.NODE_ENV === 'test' &&
      (err as { name?: string } | null)?.name === 'KnownConditionGuardError'
    ) {
      throw err;
    }
    // Error reporter may be unavailable in tests/bootstrap. Logger calls around
    // the failure preserve the diagnostic path.
  }
}

/**
 * Embedding service lifecycle counters for Stage 5 telemetry.
 *
 * Ownership: embedding service (one instance per main process).
 *
 * `gpuBlurIdleDispositions` deliberately counts ONLY blur-disposal + idle-disposal
 * events — the Stage 3/Stage 4 signal for "how much GPU init/dispose churn is
 * visibility-driven?" — NOT every `gpuBackend.dispose()` call. Service-shutdown
 * and settings-driven disposals are not counted here because they are expected
 * events that do not indicate the regression Stage 3 was designed to fix.
 *
 * `cpuInitReasonCounts` is the primary signal for validating Stage 3's lazy-init:
 * if `blur-fallback > 0` or `idle-fallback > 0` post-Stage-3, the eager-warmup
 * removal is not reducing CPU init churn as intended.
 *
 * `firstCpuInitReason` is set on the FIRST successful CPU worker init and never
 * overwritten. Failed init attempts do not update it; a successful retry does.
 */
export interface EmbeddingLifecycleStats {
  cpuWorkerSpawns: number;
  gpuBlurIdleDispositions: number;
  gpuInits: number;
  cpuEmbedBatches: number;
  gpuEmbedBatches: number;
  onnxIntraOpThreads: number;
  firstCpuInitReason: CpuWorkerInitReason | null;
  lastCpuInitReason: CpuWorkerInitReason | null;
  cpuInitReasonCounts: Record<CpuWorkerInitReason, number>;
  lastInitAt: number | null;
  lastDisposeAt: number | null;
}

const embeddingLifecycleStats: EmbeddingLifecycleStats = {
  cpuWorkerSpawns: 0,
  gpuBlurIdleDispositions: 0,
  gpuInits: 0,
  cpuEmbedBatches: 0,
  gpuEmbedBatches: 0,
  onnxIntraOpThreads: resolveIntraOpThreads(),
  firstCpuInitReason: null,
  lastCpuInitReason: null,
  cpuInitReasonCounts: {
    'startup': 0,
    'blur-fallback': 0,
    'idle-fallback': 0,
    'gpu-error-fallback': 0,
    'manual': 0,
  },
  lastInitAt: null,
  lastDisposeAt: null,
};

// BGE query prefix - improves retrieval quality for query→document matching
// From: https://huggingface.co/Xenova/bge-small-en-v1.5
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Backend state - GPU and CPU are mutually exclusive
type EmbeddingBackend = 'gpu' | 'cpu';
let activeBackend: EmbeddingBackend = 'cpu';
let gpuBackend: GpuEmbeddingBackend | null = null;

/**
 * Service state for tracking initialization and recovery.
 * Exported via getServiceStatus() for health checks.
 */
export interface EmbeddingServiceState {
  ready: boolean;
  failed: boolean;
  failedDueToCrash: boolean; // true = runtime crash, false = init failure (affects cooldown)
  attempts: number;
  lastError: string | null;
  lastAttemptAt: number | null; // timestamp for cooldown
}

// CPU Worker state (kept separate from GPU)
let worker: UtilityProcess | null = null;
let isReady = false;
let initPromise: Promise<void> | null = null;
let intentionalWorkerShutdown = false;
// REBEL-4X: Track if service has been disposed to prevent worker creation during shutdown
let isDisposed = false;

/**
 * In-MAIN-process liveness flags for the embedding backends, for the
 * native-liveness snapshot captured at the macOS quit-deadlock boundary (see
 * `nativeLivenessSnapshot.ts`). NOTE: both heavy holders are OUT-OF-PROCESS —
 * the CPU worker is a `UtilityProcess` and the GPU backend is an offscreen
 * `BrowserWindow`, so their native threads die with their own process. These
 * are therefore WEAK in-main teardown-thread suspects; the flags only tell us
 * whether `disposeEmbeddingService` completed before a hang. Synchronous,
 * allocation-free read.
 */
export function getEmbeddingLivenessSnapshot(): {
  workerAlive: boolean;
  gpuBackendAlive: boolean;
  disposed: boolean;
} {
  return { workerAlive: worker !== null, gpuBackendAlive: gpuBackend !== null, disposed: isDisposed };
}

// CPU idle disposal state
let cpuLastActivityMs = 0;
let cpuIdleTimer: NodeJS.Timeout | null = null;
let isIdleDisposed = false; // NOT isDisposed — this is recoverable (on-demand re-init)
let isDisposing = false; // Prevents concurrent init during async disposal
let pendingCpuRequestCount = 0;

// Service state - replaces simple initFailed boolean for better observability
const serviceState: EmbeddingServiceState = {
  ready: false,
  failed: false,
  failedDueToCrash: false,
  attempts: 0,
  lastError: null,
  lastAttemptAt: null
};

// GPU fallback tracking - auto-disable GPU after too many consecutive failures
const GPU_FAILURE_THRESHOLD = 5; // Switch to CPU-only after this many consecutive GPU failures
let consecutiveGpuFailures = 0;
let gpuAutoDisabled = false; // Set to true when we auto-switch to CPU due to failures

// GPU slow performance tracking - auto-disable GPU if consistently slow
// On weak integrated GPUs (Intel/AMD iGPU), embeddings can take 30-40s per batch
// vs 5-15ms expected. CPU fallback is faster (~30-100ms) so we should switch.
const GPU_SLOW_THRESHOLD_MS = 5000; // 5s - batch taking this long is "slow" (expected: 5-15ms)
const GPU_SLOW_COUNT_THRESHOLD = 3; // Auto-disable after this many consecutive slow batches
let consecutiveSlowGpuBatches = 0;

// Model corruption recovery tracking - circuit breaker to prevent infinite delete/redownload loops
let corruptionRecoveryAttempts = 0;

// GPU lifecycle metrics for diagnostic telemetry (blur disposal, warm-up cycles)
interface GpuLifecycleMetrics {
  blurDisposalCount: number;
  focusWarmUpCount: number;
  lastBlurDisposalAt: number | null;
  lastFocusWarmUpAt: number | null;
}
const gpuLifecycleMetrics: GpuLifecycleMetrics = {
  blurDisposalCount: 0,
  focusWarmUpCount: 0,
  lastBlurDisposalAt: null,
  lastFocusWarmUpAt: null,
};

// GPU re-init suppression during blur — prevents background indexing from re-creating
// the GPU backend we just intentionally disposed to save memory
let gpuReinitSuppressed = false;

// Mutex for GPU re-initialization to prevent concurrent callers from creating duplicate backends
let gpuReinitPromise: Promise<boolean> | null = null;

interface PendingRequest {
  resolve: (value: number[] | number[][]) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

const pendingRequests = new Map<string, PendingRequest>();
const modelReadyCallbacks: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

function recordCpuWorkerInit(reason: CpuWorkerInitReason): void {
  const now = Date.now();
  if (embeddingLifecycleStats.firstCpuInitReason === null) {
    embeddingLifecycleStats.firstCpuInitReason = reason;
  }
  embeddingLifecycleStats.lastCpuInitReason = reason;
  embeddingLifecycleStats.cpuInitReasonCounts[reason]++;
  embeddingLifecycleStats.lastInitAt = now;
}

function recordGpuInit(): void {
  embeddingLifecycleStats.gpuInits++;
  embeddingLifecycleStats.lastInitAt = Date.now();
}

function recordDispose(): void {
  embeddingLifecycleStats.lastDisposeAt = Date.now();
}

/**
 * Increments the blur/idle-scoped GPU disposal counter. This is the Stage 3
 * churn signal — do NOT call for service-shutdown or settings-driven disposals.
 */
function recordGpuBlurIdleDispose(): void {
  embeddingLifecycleStats.gpuBlurIdleDispositions++;
  recordDispose();
}

/**
 * Get the cache directory for transformer models
 */
function getModelCacheDir(): string {
  const userDataPath = app.getPath('userData');
  const cacheDir = path.join(userDataPath, 'models', 'transformers');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Attempt to recover from ONNX model corruption by deleting the model cache.
 * Returns true if recovery was attempted, false if circuit breaker prevented it.
 * 
 * Circuit breaker: Limited to MAX_CORRUPTION_RECOVERIES_PER_SESSION to prevent
 * infinite delete/redownload loops on persistent issues (e.g., disk full, permissions).
 */
function attemptCorruptionRecovery(errorMessage: string): boolean {
  // Check circuit breaker
  if (corruptionRecoveryAttempts >= MAX_CORRUPTION_RECOVERIES_PER_SESSION) {
    logger.error(
      {
        attempts: corruptionRecoveryAttempts,
        maxAttempts: MAX_CORRUPTION_RECOVERIES_PER_SESSION,
        errorMessage
      },
      'Model corruption recovery circuit breaker triggered - max attempts reached this session'
    );
    return false;
  }

  // Only attempt recovery for likely corruption errors
  const corruptionIndicators = [
    'Protobuf parsing failed',
    'Failed to load model',
    'Invalid model',
    'ONNX',
    'onnxruntime'
  ];
  
  const isLikelyCorruption = corruptionIndicators.some(indicator => 
    errorMessage.toLowerCase().includes(indicator.toLowerCase())
  );

  if (!isLikelyCorruption) {
    logger.debug(
      { errorMessage },
      'Error does not indicate model corruption - skipping auto-recovery'
    );
    return false;
  }

  corruptionRecoveryAttempts++;
  const modelCacheDir = getModelCacheDir();

  logger.warn(
    {
      errorMessage,
      modelCacheDir,
      recoveryAttempt: corruptionRecoveryAttempts,
      maxAttempts: MAX_CORRUPTION_RECOVERIES_PER_SESSION
    },
    'Attempting ONNX model corruption recovery - deleting model cache for re-download'
  );

  try {
    // Delete the entire model cache directory
    fs.rmSync(modelCacheDir, { recursive: true, force: true });
    logger.info({ modelCacheDir }, 'Model cache deleted successfully - will re-download on next attempt');
    return true;
  } catch (deleteError) {
    logger.error(
      { err: deleteError, modelCacheDir },
      'Failed to delete corrupted model cache'
    );
    return false;
  }
}

/**
 * Attempt to lazily re-initialize the GPU backend after idle disposal.
 * Returns true if GPU is now ready for use, false if should fall back to CPU.
 * 
 * This is called when activeBackend === 'gpu' but gpuBackend is null,
 * which happens after idle disposal (where we keep activeBackend = 'gpu'
 * to enable on-demand re-initialization).
 * 
 * Uses a mutex (gpuReinitPromise) to prevent concurrent callers from
 * creating duplicate GPU backends.
 */
async function tryReinitGpuBackend(): Promise<boolean> {
  // Mutex: if re-init is already in progress, wait for it
  if (gpuReinitPromise) {
    return gpuReinitPromise;
  }
  
  gpuReinitPromise = doTryReinitGpuBackend();
  try {
    return await gpuReinitPromise;
  } finally {
    gpuReinitPromise = null;
  }
}

/**
 * Internal implementation of GPU re-initialization.
 * Called only via tryReinitGpuBackend() which provides mutex protection.
 */
async function doTryReinitGpuBackend(): Promise<boolean> {
  // Guard: already have a backend (defensive check)
  if (gpuBackend) {
    return gpuBackend.isReady();
  }
  
  // Guard against re-init storms
  if (gpuAutoDisabled) {
    return false;
  }
  
  const hwAccelDisabled = app.commandLine.hasSwitch('disable-gpu');
  if (hwAccelDisabled) {
    return false;
  }
  
  // Use local variable until initialization succeeds to avoid exposing
  // a partially-initialized backend via the global gpuBackend reference
  let newBackend: GpuEmbeddingBackend | null = null;
  
  try {
    logger.info('Lazily re-initializing GPU backend after idle disposal');
    newBackend = new GpuEmbeddingBackend(getModelCacheDir());
    newBackend.onDisposal(createGpuIdleDisposalHandler(newBackend));
    
    const gpuAvailable = await newBackend.initialize();
    if (gpuAvailable) {
      // Guard: lifecycle state changed during async initialization
      if (gpuReinitSuppressed || isDisposed) {
        logger.info(
          { gpuReinitSuppressed, isDisposed },
          'GPU re-init completed but lifecycle state changed — disposing new backend'
        );
        try {
          await newBackend.dispose();
        } catch (disposeErr) {
          logger.warn({ err: disposeErr }, 'Failed to dispose post-init GPU backend');
        }
        return false;
      }

      // Only assign to global after successful initialization
      gpuBackend = newBackend;
      recordGpuInit();
      logger.info('GPU backend re-initialized successfully');
      return true;
    } else {
      logger.info('WebGPU not available on re-init, staying on CPU');
      await newBackend.dispose();
      activeBackend = 'cpu';
      return false;
    }
  } catch (err) {
    logger.warn({ err }, 'GPU backend re-initialization failed, falling back to CPU');
    if (newBackend) {
      try {
        await newBackend.dispose();
      } catch {
        // Ignore
      }
    }
    activeBackend = 'cpu';
    return false;
  }
}

/**
 * Create a disposal handler that's bound to a specific GPU backend instance.
 * This prevents stale callbacks from affecting a newly-created backend.
 * 
 * When the GPU backend idles out, we:
 * 1. Clear the gpuBackend reference (allows re-init on next request)
 * 2. Keep activeBackend as 'gpu' (so next request will try to re-init GPU)
 * 3. Let the next CPU fallback request initialize the worker on demand
 * 
 * This enables "lazy GPU re-initialization" - GPU is re-created on demand
 * after idle disposal, rather than permanently switching to CPU.
 */
function createGpuIdleDisposalHandler(boundInstance: GpuEmbeddingBackend): () => void {
  return () => {
    // Guard against stale callback - only handle if this is still the current backend
    if (gpuBackend !== boundInstance) {
      logger.debug('Ignoring disposal callback from stale GPU backend instance');
      return;
    }
    
    logger.info('GPU backend disposed due to idle timeout - will re-init on next request');
    gpuBackend = null;
    // IMPORTANT: Keep activeBackend = 'gpu' so next request will try to re-init
    // This enables lazy GPU re-initialization rather than permanent CPU fallback
    
    // Reset GPU failure/slow counters since this is normal idle disposal, not an error
    consecutiveGpuFailures = 0;
    consecutiveSlowGpuBatches = 0;
    
    getErrorReporter().addBreadcrumb({
      category: 'embedding',
      message: 'GPU backend idle disposal - will re-init on demand',
      level: 'info',
    });
    recordGpuBlurIdleDispose();
    
    // Lazy init: next generateEmbeddingCpu() call handles first-request init on demand
    // (see lazy-fallback path at generateEmbeddingCpu references around lines 1217, 1235, 1358, 1607, 1660).
    // Removed eager warmup to reclaim ~350-400 MB RSS in the common "blurred, idle" path.
    // Restore eager behaviour with REBEL_DISABLE_LAZY_CPU_WARMUP=1 if user reports first-request latency regression.
    if (process.env.REBEL_DISABLE_LAZY_CPU_WARMUP === '1') {
      void initializeCpuWorker('idle-fallback').catch(err => {
        logger.warn({ err }, 'CPU worker initialization failed after GPU idle disposal');
      });
    }
  };
}

/**
 * Auto-disable GPU backend due to repeated failures (errors/crashes).
 * Disposes GPU backend and switches to CPU-only mode.
 */
function autoDisableGpuDueToFailures(): void {
  gpuAutoDisabled = true;
  getErrorReporter().addBreadcrumb({
    category: 'embedding',
    message: 'GPU auto-disabled due to failures',
    data: { consecutiveGpuFailures },
    level: 'warning',
  });
  // Dispose GPU backend to release memory immediately
  const toDispose = gpuBackend;
  gpuBackend = null;
  if (toDispose) {
    void toDispose.dispose().catch(err => {
      logger.warn({ err }, 'Failed to dispose GPU backend after auto-disable');
    });
  }
  logger.error(
    { consecutiveFailures: consecutiveGpuFailures },
    'GPU backend auto-disabled due to repeated failures - using CPU only until restart'
  );
}

/**
 * Auto-disable GPU backend due to slow performance (weak integrated graphics).
 * On weak iGPUs (Intel UHD, AMD Vega), GPU embeddings can take 30-40s per batch
 * while CPU can do the same work in ~30-100ms. Switching to CPU improves UX.
 */
function autoDisableGpuDueToSlowness(lastElapsedMs: number): void {
  gpuAutoDisabled = true;
  getErrorReporter().addBreadcrumb({
    category: 'embedding',
    message: 'GPU auto-disabled due to slow performance',
    data: { consecutiveSlowGpuBatches, lastElapsedMs, threshold: GPU_SLOW_THRESHOLD_MS },
    level: 'warning',
  });
  // Dispose GPU backend to release memory and stop wasted cycles
  const toDispose = gpuBackend;
  gpuBackend = null;
  if (toDispose) {
    void toDispose.dispose().catch(err => {
      logger.warn({ err }, 'Failed to dispose GPU backend after slow-performance auto-disable');
    });
  }
  logger.warn(
    { consecutiveSlowBatches: consecutiveSlowGpuBatches, lastElapsedMs, thresholdMs: GPU_SLOW_THRESHOLD_MS },
    'GPU backend auto-disabled due to slow performance (likely weak integrated graphics) - using CPU only until restart. CPU embeddings are faster on this hardware.'
  );
}

/**
 * Split an array into chunks of the specified size.
 * Used for batch size limiting to prevent OOM in embedding worker.
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Get the path to the worker script
 * In dev: out/main/workers/embeddingWorker.js (built by scripts/build-worker.mjs)
 * In packaged: app.asar.unpacked (due to asar.unpack config)
 */
function getWorkerPath(): string {
  if (app.isPackaged) {
    // Worker is in app.asar.unpacked due to asar.unpack: '**/workers/**' config
    return path.join(
      app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
      'workers',
      'embeddingWorker.js'
    );
  }

  // Development: worker is built to out/main/workers/ by scripts/build-worker.mjs
  // The main process runs from .vite/build/ but worker is in out/main/workers/
  // Try multiple possible locations
  const possiblePaths = [
    // Relative to __dirname (works if worker is in same build dir)
    path.join(__dirname, 'workers', 'embeddingWorker.js'),
    // Absolute path to out/main/workers (where build-worker.mjs outputs)
    path.join(app.getAppPath(), 'out', 'main', 'workers', 'embeddingWorker.js'),
    // Fallback for different project structures
    path.join(process.cwd(), 'out', 'main', 'workers', 'embeddingWorker.js')
  ];

  for (const workerPath of possiblePaths) {
    if (fs.existsSync(workerPath)) {
      return workerPath;
    }
  }

  // Return the most likely path for error messaging
  return possiblePaths[1];
}

/**
 * Reject all pending requests - called on worker exit/error
 */
function rejectAllPending(error: Error): void {
  for (const [_id, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  pendingRequests.clear();
}

/**
 * Notify all callbacks waiting for model ready
 */
function notifyModelReadyCallbacks(error?: Error): void {
  for (const cb of modelReadyCallbacks) {
    if (error) {
      cb.reject(error);
    } else {
      cb.resolve();
    }
  }
  modelReadyCallbacks.length = 0;
}

// ── CPU idle disposal helpers ──

/**
 * Mark CPU embedding activity to reset the idle timer.
 * Called at the start of every CPU embedding request.
 */
function markCpuActivity(): void {
  cpuLastActivityMs = Date.now();
  rescheduleCpuIdleTimer();
}

/**
 * Clear the CPU idle timer if active.
 */
function clearCpuIdleTimer(): void {
  if (cpuIdleTimer) {
    clearTimeout(cpuIdleTimer);
    cpuIdleTimer = null;
  }
}

/**
 * Start or restart the CPU idle disposal timer.
 * Only active when isCpuIdleDisposalEnabled() is true.
 * Follows the GPU idle timer pattern from gpuEmbeddingBackend.ts.
 */
function rescheduleCpuIdleTimer(): void {
  clearCpuIdleTimer();
  if (!isCpuIdleDisposalEnabled()) return;
  if (!worker || !isReady || isDisposing || isDisposed) return;

  const timeSinceActivity = Date.now() - cpuLastActivityMs;
  const timeUntilIdle = Math.max(0, CPU_IDLE_TIMEOUT_MS - timeSinceActivity);
  // Minimum delay to prevent busy-loop
  const MIN_RESCHEDULE_DELAY_MS = 1000;
  const delay = Math.max(timeUntilIdle, MIN_RESCHEDULE_DELAY_MS);

  cpuIdleTimer = setTimeout(() => {
    const idleMs = Date.now() - cpuLastActivityMs;
    // Double-check all guards before disposing
    if (
      idleMs >= CPU_IDLE_TIMEOUT_MS &&
      worker &&
      isReady &&
      !isDisposing &&
      !isDisposed &&
      pendingCpuRequestCount === 0
    ) {
      fireAndForget(disposeCpuWorkerForIdle(), 'embeddingService.line840');
    } else if (pendingCpuRequestCount > 0) {
      // Has pending requests — reschedule
      logger.debug(
        { pendingCpuRequestCount, idleMs, profilerChannel: 'embedding-lifecycle' },
        'CPU idle timer rescheduled — pending requests'
      );
      rescheduleCpuIdleTimer();
    } else if (worker && isReady && !isDisposing) {
      // Not yet idle — reschedule for remaining time
      rescheduleCpuIdleTimer();
    }
  }, delay);
}

/**
 * Start the CPU idle timer after successful worker initialization.
 * Only active when isCpuIdleDisposalEnabled() is true.
 */
function startCpuIdleTimer(): void {
  if (!isCpuIdleDisposalEnabled()) return;
  cpuLastActivityMs = Date.now();
  rescheduleCpuIdleTimer();
}

/**
 * Dispose the CPU worker due to idle timeout.
 * Reclaims ~350-400 MB RAM (worker RSS, per historical logs). Worker is re-initialized on-demand
 * on next request. First-request latency is 0.35-1.3 s after idle/blur disposal; see plan § Stage 3.
 *
 * TOCTOU guard: sets isReady = false synchronously BEFORE async disposal.
 * isDisposing flag prevents concurrent init during disposal.
 * Does NOT set isDisposed (permanent shutdown) — uses isIdleDisposed instead.
 */
async function disposeCpuWorkerForIdle(): Promise<void> {
  // Synchronous TOCTOU guard — prevents new requests from using worker
  isReady = false;
  isDisposing = true;
  serviceState.ready = false;

  clearCpuIdleTimer();

  if (!worker) {
    // Worker already gone — just clean up state
    isDisposing = false;
    isIdleDisposed = true;
    initPromise = null;
    return;
  }
  const w: Electron.UtilityProcess = worker;

  try {
    // Dispose handshake: send dispose, wait for ack, then kill
    const disposePromise = new Promise<void>((resolve) => {
      // eslint-disable-next-line prefer-const -- assigned after cleanup closure captures it
      let timeoutId: NodeJS.Timeout | undefined;

      function cleanup() {
        if (timeoutId) clearTimeout(timeoutId);
        w.off('message', onMessage);
        w.off('exit', onExit);
      }

      function onMessage(response: { type: string }) {
        if (response.type === 'disposed') {
          cleanup();
          resolve();
        }
      }

      function onExit() {
        cleanup();
        resolve();
      }

      // Register listeners BEFORE posting dispose to avoid race
      w.on('message', onMessage);
      w.on('exit', onExit);

      // Timeout fallback in case worker hangs
      timeoutId = setTimeout(() => {
        logger.warn(
          { profilerChannel: 'embedding-lifecycle' },
          'CPU idle disposal handshake timeout — forcing termination'
        );
        cleanup();
        resolve();
      }, CPU_IDLE_DISPOSE_HANDSHAKE_TIMEOUT_MS);
    });

    w.postMessage({ type: 'dispose' });
    await disposePromise;

    intentionalWorkerShutdown = true;
    try {
      w.kill();
    } catch {
      // Ignore — worker may have already exited
    }
  } catch (err) {
    logger.warn({ err, profilerChannel: 'embedding-lifecycle' }, 'CPU idle disposal error');
  }

  // Clean up state
  worker = null;
  initPromise = null;
  isIdleDisposed = true;
  isDisposing = false;

  logger.info(
    { profilerChannel: 'embedding-lifecycle' },
    'CPU embedding worker idle-disposed — will re-init on next request'
  );
  recordDispose();

  getErrorReporter().addBreadcrumb({
    category: 'embedding',
    message: 'CPU embedding worker idle-disposed',
    level: 'info',
  });
}

/**
 * Single attempt to initialize the CPU worker process.
 * Returns a promise that resolves on success or rejects on failure.
 * Does NOT set serviceState.failed - that's handled by the retry wrapper.
 */
function attemptWorkerInit(
  workerPath: string,
  attemptNumber: number,
  initReason: CpuWorkerInitReason,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false; // Guard against late messages after timeout
    logger.info({ workerPath, attempt: attemptNumber, maxAttempts: MAX_INIT_RETRIES }, 'Attempting embedding worker initialization...');

    // Init timeout
    const initTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error('Worker initialization timed out');
      logger.error({ timeoutMs: INIT_TIMEOUT_MS, attempt: attemptNumber }, error.message);
      cleanup(error);
      reject(error);
    }, INIT_TIMEOUT_MS);

    function cleanup(error?: Error) {
      clearTimeout(initTimeout);
      if (error) {
        rejectAllPending(error);
        if (worker) {
          intentionalWorkerShutdown = true;
          try {
            worker.kill();
          } catch {
            // Ignore
          }
          worker = null;
        }
        isReady = false;
      }
    }

    // Resolve the thread cap once — used for both the ORT session_options plumbing below
    // AND the Windows OMP_NUM_THREADS belt-and-braces, so the two signals stay consistent
    // even on low-core hosts (see lens-gpt5.5-high Stage 2 review).
    const intraOpThreads = resolveIntraOpThreads();
    embeddingLifecycleStats.onnxIntraOpThreads = intraOpThreads;

    // Historical belt-and-braces for older ORT/OpenMP builds. The primary thread cap now
    // comes from session_options.intraOpNumThreads in the worker init message below.
    // Mirror resolveIntraOpThreads() here so a 2-core Windows host does not get OMP_NUM_THREADS=4
    // while the ORT session_options say intraOpNumThreads=1.
    const workerEnv: NodeJS.ProcessEnv =
      process.platform === 'win32' && !process.env.OMP_NUM_THREADS
        ? { ...process.env, OMP_NUM_THREADS: String(intraOpThreads) }
        : process.env;

    const ompNumThreads = workerEnv.OMP_NUM_THREADS;

    try {
      worker = utilityProcess.fork(workerPath, [], {
        serviceName: 'Embedding Worker',
        env: workerEnv,
        stdio: 'pipe'
      });
      embeddingLifecycleStats.cpuWorkerSpawns++;

      // Drain stdout/stderr pipes to prevent worker deadlock if it writes to them.
      const MAX_PIPE_BUFFER_LINES = 100;
      let stdoutLines = 0;
      let stderrLines = 0;

      worker.stdout?.on('data', (data: Buffer) => {
        if (stdoutLines < MAX_PIPE_BUFFER_LINES) {
          const output = data.toString().trim();
          if (output) {
            logger.debug({ output, source: 'embedding-worker-stdout' }, 'Worker stdout');
            stdoutLines++;
          }
        }
      });

      worker.stderr?.on('data', (data: Buffer) => {
        if (stderrLines < MAX_PIPE_BUFFER_LINES) {
          const errorOutput = data.toString().trim();
          if (errorOutput) {
            logger.warn({ error: errorOutput, source: 'embedding-worker-stderr' }, 'Worker stderr');
            stderrLines++;
          }
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: error, attempt: attemptNumber }, 'Failed to create worker');
      cleanup(error);
      reject(error);
      return;
    }

    worker.on('message', (rawMsg: unknown) => {
      const msg = rawMsg as {
        type?: string;
        id?: unknown;
        vector?: unknown;
        vectors?: unknown;
        error?: unknown;
      };

      try {
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
          return;
        }

        const msgId = typeof msg.id === 'string' ? msg.id : undefined;

        if (msg.type === 'ready') {
          if (settled) return; // Ignore late ready message after timeout
          settled = true;
          clearTimeout(initTimeout);
          isReady = true;
          serviceState.ready = true;
          serviceState.failed = false;
          recordCpuWorkerInit(initReason);
          const elapsed = Date.now() - startTime;
          logger.info({ elapsedMs: elapsed, attempt: attemptNumber }, 'Embedding worker ready');
          if (process.platform === 'win32') {
            logger.info({ ompNumThreads }, 'Windows: ONNX Runtime thread limit applied');
          }
          notifyModelReadyCallbacks();
          resolve();
        } else if (msg.type === 'embedding') {
          if (!msgId) return;
          const pending = pendingRequests.get(msgId);
          if (!pending) return;

          clearTimeout(pending.timeoutId);
          pendingRequests.delete(msgId);

          if (!Array.isArray(msg.vector)) {
            pending.reject(new Error('Worker returned invalid embedding payload'));
            return;
          }

          try {
            pending.resolve(msg.vector as number[]);
          } catch (err) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
        } else if (msg.type === 'embeddings') {
          if (!msgId) return;
          const pending = pendingRequests.get(msgId);
          if (!pending) return;

          clearTimeout(pending.timeoutId);
          pendingRequests.delete(msgId);

          if (!Array.isArray(msg.vectors)) {
            pending.reject(new Error('Worker returned invalid embeddings payload'));
            return;
          }

          try {
            pending.resolve(msg.vectors as number[][]);
          } catch (err) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
        } else if (msg.type === 'error') {
          const pending = msgId ? pendingRequests.get(msgId) : undefined;
          const message = typeof msg.error === 'string' ? msg.error : 'Unknown worker error';

          if (pending && msgId) {
            clearTimeout(pending.timeoutId);
            pendingRequests.delete(msgId);
            pending.reject(new Error(message));
          } else if (msg.id == null && !settled) {
            // Init-time error (id is undefined/null) - likely ONNX model corruption
            settled = true;
            const error = new Error(`Worker initialization failed: ${message}`);
            logger.error(
              {
                errorMessage: message,
                attempt: attemptNumber,
                modelCacheDir: getModelCacheDir()
              },
              'Worker initialization error (possible ONNX model corruption)'
            );
            cleanup(error);
            reject(error);
          } else {
            // Unassociated error after init - just log
            logger.error(
              { errorMessage: typeof msg.error === 'string' ? msg.error : 'Unknown worker error' },
              'Worker error'
            );
          }
        } else if (msg.type === 'disposed') {
          logger.info('Embedding worker disposed');
        }
      } catch (err) {
        logger.error(
          {
            err,
            msgType: typeof msg?.type === 'string' ? msg.type : undefined,
            msgId: typeof msg?.id === 'string' ? msg.id : undefined
          },
          'Embedding worker message handler failed'
        );

        if (typeof msg?.id === 'string') {
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pendingRequests.delete(msg.id);
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    });

    worker.on('exit', (code) => {
      const signal = code !== null && code > 128 ? code - 128 : null;
      const signalNames: Record<number, string> = { 5: 'SIGTRAP', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV' };
      const signalName = signal ? signalNames[signal] ?? `SIG${signal}` : null;

      const wasReady = isReady;
      worker = null;
      isReady = false;
      serviceState.ready = false;

      if (intentionalWorkerShutdown) {
        intentionalWorkerShutdown = false;
        return;
      }

      if (isDisposed || isShuttingDown()) {
        return;
      }

      // REBEL-4X: Reject on ANY exit if not yet ready/settled to avoid hanging promises
      // (handles shutdown termination which may exit with code 0)
      if (!wasReady && !settled) {
        settled = true;
        const error = new Error(`Worker exited with code ${code}`);
        if (code !== 0) {
          logger.warn(
            { exitCode: code, signal: signalName, attempt: attemptNumber },
            'Embedding worker exited unexpectedly'
          );
        }
        rejectAllPending(error);
        notifyModelReadyCallbacks(error);
        reject(error);
      } else if (code !== 0) {
        // Worker was ready but exited with error (runtime crash) - use shorter cooldown
        const error = new Error(`Worker exited with code ${code}`);
        logger.warn(
          { exitCode: code, signal: signalName, attempt: attemptNumber },
          'Embedding worker crashed - will use shorter recovery cooldown'
        );
        serviceState.failed = true;
        serviceState.failedDueToCrash = true; // Runtime crash - use CRASH_COOLDOWN_MS
        serviceState.lastError = `Embedding worker crashed (exitCode=${code}${signalName ? `, signal=${signalName}` : ''})`;
        serviceState.lastAttemptAt = Date.now();
        rejectAllPending(error);
      } else if (wasReady) {
        // Unintentional clean exit while requests may be in-flight; treat as crash for faster recovery
        const error = new Error('Embedding worker exited unexpectedly');
        logger.warn({ exitCode: code, signal: signalName, attempt: attemptNumber }, error.message);
        serviceState.failed = true;
        serviceState.failedDueToCrash = true; // Treat as crash - use CRASH_COOLDOWN_MS
        serviceState.lastError = `Embedding worker exited unexpectedly (exitCode=${code}${signalName ? `, signal=${signalName}` : ''})`;
        serviceState.lastAttemptAt = Date.now();
        rejectAllPending(error);
      }
    });

    // Send init message with cache directory + unpacked node_modules for native addons.
    // intraOpThreads was resolved once above so the ORT session_options and the Windows
    // OMP_NUM_THREADS fallback agree on the same value.
    worker.postMessage({
      type: 'init',
      cacheDir: getModelCacheDir(),
      unpackedNodeModules: app.isPackaged
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- process.resourcesPath is guaranteed when app.isPackaged is true (Electron API contract)
        ? path.join(process.resourcesPath!, 'app.asar.unpacked', 'node_modules')
        : undefined,
      onnxIntraOpThreads: intraOpThreads
    });
    logger.info(
      { onnxIntraOpThreads: intraOpThreads, platform: process.platform, cores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length },
      'Embedding worker init: thread cap set'
    );
  });
}

/**
 * Initialize the CPU worker process and load the embedding model.
 * Includes retry logic with exponential backoff for transient failures.
 *
 * Thread safety: Uses initPromise as guard - concurrent callers share the same promise.
 */
async function initializeCpuWorker(initReason: CpuWorkerInitReason): Promise<void> {
  // REBEL-4X: Prevent worker creation during shutdown to avoid V8 platform crash
  if (isDisposed || isShuttingDown()) {
    logger.info('Skipping CPU worker init - service disposed or app shutting down');
    // Reject any pending waitForModelReady() callers to avoid hanging promises
    notifyModelReadyCallbacks(new Error('Embedding service unavailable - app shutting down'));
    return;
  }

  // Wait for idle disposal to complete before attempting re-init
  if (isDisposing) {
    logger.debug('Waiting for CPU idle disposal to complete before re-init');
    // Poll until disposal completes (bounded by dispose handshake timeout)
    const waitStart = Date.now();
    while (isDisposing && Date.now() - waitStart < CPU_IDLE_DISPOSE_HANDSHAKE_TIMEOUT_MS + 1000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isDisposing) {
      throw new Error('CPU worker disposal did not complete in time');
    }
  }

  // Enforce cooldown after hard failures/crashes to avoid restart thrashing.
  // Runtime crashes use shorter cooldown (5s) vs init failures (30s) for faster recovery.
  if (serviceState.failed) {
    const now = Date.now();
    const cooldownMs = serviceState.failedDueToCrash ? CRASH_COOLDOWN_MS : RETRY_COOLDOWN_MS;
    if (serviceState.lastAttemptAt && now - serviceState.lastAttemptAt < cooldownMs) {
      const remainingMs = cooldownMs - (now - serviceState.lastAttemptAt);
      throw new Error(
        `Embedding model initialization previously failed. Retry available in ${Math.ceil(remainingMs / 1000)}s`
      );
    }

    logger.info(
      { lastAttemptAt: serviceState.lastAttemptAt, failedDueToCrash: serviceState.failedDueToCrash, cooldownMs },
      'Auto-recovery: cooldown elapsed, retrying initialization'
    );
    serviceState.failed = false;
    serviceState.failedDueToCrash = false;
    serviceState.attempts = 0;
    serviceState.lastError = null;
  }

  if (worker && isReady) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const workerPath = getWorkerPath();

    // Verify worker file exists (non-retriable error)
    if (!fs.existsSync(workerPath)) {
      const error = new Error(`Worker file not found: ${workerPath}`);
      logger.error({ workerPath }, error.message);
      serviceState.failed = true;
      serviceState.failedDueToCrash = false; // Init failure, not crash - use longer cooldown
      serviceState.attempts = 1; // Count as one attempt for health reporting
      serviceState.lastError = error.message;
      serviceState.lastAttemptAt = Date.now();
      initPromise = null;
      notifyModelReadyCallbacks(error);
      reportEmbeddingInitFailureOnce(error, {
        attempts: serviceState.attempts,
        initReason,
        modelCacheDir: getModelCacheDir(),
      });
      throw error;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
      // REBEL-4X: Re-check shutdown state before each attempt to avoid creating
      // workers during shutdown (addresses race where shutdown starts during retry delay)
      if (isDisposed || isShuttingDown()) {
        logger.info('Aborting worker init retry - service disposed or app shutting down');
        initPromise = null;
        notifyModelReadyCallbacks(new Error('Embedding service unavailable - app shutting down'));
        return;
      }

      serviceState.attempts = attempt;
      serviceState.lastAttemptAt = Date.now();
      serviceState.lastError = null; // Clear stale error when starting new attempt
      try {
        await attemptWorkerInit(workerPath, attempt, initReason);
        // Success - clear initPromise so future calls can re-init if worker dies
        initPromise = null;
        // Clear idle disposal state on successful (re-)init
        if (isIdleDisposed) {
          isIdleDisposed = false;
          logger.info(
            { profilerChannel: 'embedding-lifecycle' },
            'CPU embedding worker re-initialized after idle disposal'
          );
        }
        // Start idle timer for the new worker
        startCpuIdleTimer();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        serviceState.lastError = lastError.message;
        
        // Cleanup worker between retries to prevent resource leaks
        if (worker) {
          intentionalWorkerShutdown = true;
          try {
            worker.kill();
          } catch {
            // Ignore
          }
          worker = null;
        }
        isReady = false;
        serviceState.ready = false;

        if (attempt < MAX_INIT_RETRIES) {
          const delayMs = INIT_RETRY_DELAYS_MS[attempt - 1] ?? INIT_RETRY_DELAYS_MS[INIT_RETRY_DELAYS_MS.length - 1];
          logger.warn(
            { attempt, maxAttempts: MAX_INIT_RETRIES, delayMs, error: lastError.message },
            'Worker initialization failed, retrying after delay...'
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // All retries exhausted - attempt corruption recovery before giving up
    logger.error(
      { attempts: MAX_INIT_RETRIES, error: lastError?.message },
      'Worker initialization failed after all retry attempts'
    );

    // Try to recover from model corruption by deleting the cache
    // This will allow a fresh download on the next attempt (after cooldown)
    if (lastError && attemptCorruptionRecovery(lastError.message)) {
      logger.info('Model cache deleted due to suspected corruption - will re-download on next initialization attempt');
    }
    serviceState.failed = true;
    serviceState.failedDueToCrash = false; // Init failure, not crash - use longer cooldown
    serviceState.lastAttemptAt = Date.now();
    initPromise = null;
    // lastError is guaranteed non-null after the for loop ran at least one iteration;
    // defensive fallback avoids the non-null assertion
    const finalError = lastError ?? new Error('Worker initialization failed after all retry attempts');
    notifyModelReadyCallbacks(finalError);
    reportEmbeddingInitFailureOnce(finalError, {
      attempts: MAX_INIT_RETRIES,
      initReason,
      modelCacheDir: getModelCacheDir(),
    });
    throw finalError;
  })();

  return initPromise;
}

/**
 * Wait for the embedding model to be ready.
 * Returns immediately if already loaded, otherwise waits.
 *
 * Auto-recovery: If previously failed and cooldown has elapsed,
 * automatically attempts re-initialization.
 */
export function waitForModelReady(): Promise<void> {
  // If GPU backend is active and ready, we're good
  if (activeBackend === 'gpu' && gpuBackend?.isReady()) return Promise.resolve();
  // If CPU backend is ready, we're good
  if (activeBackend === 'cpu' && isReady) return Promise.resolve();
  // If GPU was auto-disabled but CPU is ready, we're good (fallback state)
  if (gpuAutoDisabled && isReady) return Promise.resolve();

  // Auto-recovery: If failed, check if cooldown has elapsed
  // Runtime crashes use shorter cooldown (5s) vs init failures (30s) for faster recovery.
  if (serviceState.failed) {
    const now = Date.now();
    const cooldownMs = serviceState.failedDueToCrash ? CRASH_COOLDOWN_MS : RETRY_COOLDOWN_MS;
    if (serviceState.lastAttemptAt && now - serviceState.lastAttemptAt < cooldownMs) {
      // Within cooldown - reject immediately to prevent retry storms
      const remainingMs = cooldownMs - (now - serviceState.lastAttemptAt);
      return Promise.reject(
        new Error(`Embedding model initialization previously failed. Retry available in ${Math.ceil(remainingMs / 1000)}s`)
      );
    }
    // Cooldown elapsed - attempt recovery
    logger.info(
      { lastAttemptAt: serviceState.lastAttemptAt, failedDueToCrash: serviceState.failedDueToCrash, cooldownMs },
      'Auto-recovery: cooldown elapsed, retrying initialization'
    );
    serviceState.failed = false;
    serviceState.failedDueToCrash = false;
    serviceState.attempts = 0;
    // Fall through to init
  }

  return new Promise((resolve, reject) => {
    modelReadyCallbacks.push({ resolve, reject });
    // Trigger init if not already started
    if (!initPromise) {
      void initializeCpuWorker('startup').catch(() => {
        // Error already handled via callbacks
      });
    }
  });
}

/**
 * Get the current service state for health checks and debugging.
 * Returns a copy to prevent external mutation.
 */
export function getServiceStatus(): EmbeddingServiceState {
  return { ...serviceState };
}

export function getEmbeddingLifecycleStats(): EmbeddingLifecycleStats {
  return {
    ...embeddingLifecycleStats,
    cpuInitReasonCounts: { ...embeddingLifecycleStats.cpuInitReasonCounts },
  };
}

/**
 * Force retry initialization of the embedding service.
 * Enforces a 10s cooldown to prevent retry storms.
 *
 * @returns true if retry was initiated, false if within cooldown period
 */
export async function forceRetryInitialization(): Promise<boolean> {
  // Check cooldown
  const now = Date.now();
  if (serviceState.lastAttemptAt && now - serviceState.lastAttemptAt < RETRY_COOLDOWN_MS) {
    const remainingMs = RETRY_COOLDOWN_MS - (now - serviceState.lastAttemptAt);
    logger.info(
      { remainingMs, cooldownMs: RETRY_COOLDOWN_MS },
      'Force retry blocked: within cooldown period'
    );
    return false;
  }

  // Reset state and attempt re-initialization
  logger.info('Force retry: resetting state and attempting initialization');
  serviceState.failed = false;
  serviceState.failedDueToCrash = false;
  serviceState.attempts = 0;
  serviceState.lastError = null;
  initPromise = null; // Allow new init attempt

  try {
    await initializeCpuWorker('manual');
    return true;
  } catch (err) {
    logger.error({ err }, 'Force retry initialization failed');
    return false;
  }
}

/**
 * Generate embedding using CPU backend.
 * Extracted to allow GPU fallback to call this directly.
 * @param callerIntent - Controls queue priority and timeout. Boolean values are
 * accepted only for compatibility: true = user_query, false = background_indexing.
 */
async function generateEmbeddingCpu(
  text: string,
  callerIntent: CallerIntent | boolean = 'background_indexing',
  initReasonOverride?: CpuWorkerInitReason,
): Promise<Float32Array> {
  const intent = normalizeCallerIntent(callerIntent);
  const priority = usesPriorityQueue(intent);
  markCpuActivity();
  pendingCpuRequestCount++;
  const initReason: CpuWorkerInitReason = initReasonOverride ?? (
    gpuAutoDisabled
      ? 'gpu-error-fallback'
      : activeBackend === 'gpu' && !gpuBackend
        ? (gpuReinitSuppressed ? 'blur-fallback' : 'idle-fallback')
        : 'startup'
  );

  try {
    await initializeCpuWorker(initReason);

    if (!worker) {
      throw new Error('Worker not initialized');
    }

    const id = crypto.randomUUID();
    const timeoutMs = priority ? PRIORITY_REQUEST_TIMEOUT_MS : BATCH_REQUEST_TIMEOUT_MS;

    const vector = await new Promise<Float32Array>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Embedding request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingRequests.set(id, {
        resolve: (vector) => resolve(new Float32Array(vector as number[])),
        reject,
        timeoutId
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- worker is guaranteed non-null: initializeCpuWorker() + explicit null check above
      worker!.postMessage({ type: 'embed', id, text, priority });
    });
    embeddingLifecycleStats.cpuEmbedBatches++;
    return vector;
  } finally {
    pendingCpuRequestCount--;
    markCpuActivity();
  }
}

/**
 * Generate embeddings for a single text (document embedding - no prefix).
 * Use this for indexing documents/files (background work) or foreground tool
 * calls that must not wait for the active turn to clear.
 * Routes to GPU or CPU backend based on initialization.
 * Falls back to CPU on GPU errors to ensure reliability.
 * Auto-disables GPU if consistently slow (weak iGPU detection).
 * @param callerIntent - `background_indexing` waits on the active-turn gate;
 * `user_query` and `foreground_tool` bypass it. Boolean values are accepted
 * for compatibility: true = user_query, false = background_indexing.
 */
export function generateEmbedding(text: string, callerIntent?: CallerIntent): Promise<Float32Array>;
export function generateEmbedding(text: string, legacyIsPriority: boolean): Promise<Float32Array>;
export async function generateEmbedding(
  text: string,
  callerIntent: CallerIntent | boolean = 'background_indexing',
): Promise<Float32Array> {
  const intent = normalizeCallerIntent(callerIntent);

  // Stage 6 (260508) + C22 (260529): only background indexing yields to the
  // active-turn signal. Foreground tools bypass so they cannot wait on the
  // same active turn that is awaiting their tool result.
  if (intent === 'background_indexing') {
    await awaitBackgroundEmbedGate();
  }

  // Lazy GPU re-initialization after idle disposal
  // When GPU idled out, we kept activeBackend = 'gpu' but cleared gpuBackend
  // On next request, start GPU re-init in background and use pre-warmed CPU for this request.
  // This avoids a 3-15s block on user-facing semantic search (keystroke-driven, 150ms debounce).
  // Skip re-init if suppressed (blur disposal — re-creating GPU defeats the memory saving).
  if (activeBackend === 'gpu' && !gpuBackend && !gpuAutoDisabled) {
    if (!gpuReinitSuppressed) {
      void tryReinitGpuBackend().catch(err =>
        logger.warn({ err }, 'Background GPU re-init failed')
      );
    }
    return generateEmbeddingCpu(text, intent);
  }
  
  // Use GPU backend if active, available, ready, and not auto-disabled
  // The isReady() check prevents "GPU backend not initialized" errors after idle disposal
  if (activeBackend === 'gpu' && gpuBackend && gpuBackend.isReady() && !gpuAutoDisabled) {
    const startMs = Date.now();
    try {
      const result = await gpuBackend.generateEmbedding(text, intent);
      embeddingLifecycleStats.gpuEmbedBatches++;
      const elapsedMs = Date.now() - startMs;
      
      // Success - reset failure counter
      consecutiveGpuFailures = 0;
      
      // Check for slow GPU (weak integrated graphics detection)
      if (elapsedMs > GPU_SLOW_THRESHOLD_MS) {
        consecutiveSlowGpuBatches++;
        logger.warn(
          { elapsedMs, threshold: GPU_SLOW_THRESHOLD_MS, consecutiveSlow: consecutiveSlowGpuBatches },
          'GPU embedding slow - may indicate weak integrated graphics'
        );
        
        if (consecutiveSlowGpuBatches >= GPU_SLOW_COUNT_THRESHOLD) {
          autoDisableGpuDueToSlowness(elapsedMs);
        }
      } else {
        // Fast enough - reset slow counter
        consecutiveSlowGpuBatches = 0;
      }
      
      return result;
    } catch (err) {
      consecutiveGpuFailures++;
      logger.warn(
        { err, consecutiveFailures: consecutiveGpuFailures, threshold: GPU_FAILURE_THRESHOLD },
        'GPU embedding failed, falling back to CPU'
      );
      
      // Auto-disable GPU after too many consecutive failures
      if (consecutiveGpuFailures >= GPU_FAILURE_THRESHOLD) {
        autoDisableGpuDueToFailures();
      }
      
      // Fall through to CPU
    }
  }

  // Use CPU backend
  return generateEmbeddingCpu(text, intent, 'gpu-error-fallback');
}

/**
 * Generate embedding for a search query (user-facing, PRIORITY).
 * Uses BGE-recommended prefix for better retrieval quality.
 * Use this for search queries (not for indexing documents).
 * Intent: user_query - these jump ahead of background indexing work.
 */
export async function generateQueryEmbedding(text: string): Promise<Float32Array> {
  // BGE models perform better with query prefix for retrieval
  return generateEmbedding(BGE_QUERY_PREFIX + text, 'user_query');
}

/**
 * Generate embeddings for multiple texts using CPU backend.
 * Extracted to allow GPU fallback to call this directly.
 * Batch requests are NOT priority - they yield to user-facing query embeddings.
 */
async function generateEmbeddingsCpu(
  texts: string[],
  initReasonOverride?: CpuWorkerInitReason,
): Promise<Float32Array[]> {
  markCpuActivity();
  pendingCpuRequestCount++;
  const initReason: CpuWorkerInitReason = initReasonOverride ?? (
    gpuAutoDisabled
      ? 'gpu-error-fallback'
      : activeBackend === 'gpu' && !gpuBackend
        ? (gpuReinitSuppressed ? 'blur-fallback' : 'idle-fallback')
        : 'startup'
  );

  try {
    await initializeCpuWorker(initReason);

    if (!worker) {
      throw new Error('Worker not initialized');
    }

    const id = crypto.randomUUID();

    const vectors = await new Promise<Float32Array[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Batch embedding request timed out after ${BATCH_REQUEST_TIMEOUT_MS}ms`));
      }, BATCH_REQUEST_TIMEOUT_MS);

      pendingRequests.set(id, {
        resolve: (vectors) => resolve((vectors as number[][]).map((v) => new Float32Array(v))),
        reject,
        timeoutId
      });
      // priority: false - batch requests yield to user-facing queries
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- worker is guaranteed non-null: initializeCpuWorker() + explicit null check above
      worker!.postMessage({ type: 'embedBatch', id, texts, priority: false });
    });
    embeddingLifecycleStats.cpuEmbedBatches++;
    return vectors;
  } finally {
    pendingCpuRequestCount--;
    markCpuActivity();
  }
}

/**
 * Generate embeddings for multiple texts (batched for efficiency)
 * Routes to GPU or CPU backend based on initialization.
 * Falls back to CPU on GPU errors to ensure reliability.
 * 
 * Large batches are automatically split into sub-batches to prevent OOM.
 * See docs/plans/finished/260128_embedding-batch-size-limit.md for details.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  // Stage 6 (260508): batch embeddings are always background work — gate on
  // the active-turn signal before doing any heavy work.
  await awaitBackgroundEmbedGate();

  // Split into sub-batches to prevent OOM in embedding worker
  if (texts.length > MAX_EMBEDDING_BATCH_SIZE) {
    const batches = chunkArray(texts, MAX_EMBEDDING_BATCH_SIZE);
    logger.debug(
      { total: texts.length, maxBatchSize: MAX_EMBEDDING_BATCH_SIZE, batches: batches.length },
      'Splitting large batch into sub-batches'
    );
    const results: Float32Array[] = [];
    for (const batch of batches) {
      const batchResults = await generateEmbeddings(batch); // Recursive call for each sub-batch
      results.push(...batchResults);
    }
    return results;
  }

  // Lazy GPU re-initialization after idle disposal
  // When GPU idled out, we kept activeBackend = 'gpu' but cleared gpuBackend
  // Start GPU re-init in background and use pre-warmed CPU for this request.
  // Skip re-init if suppressed (blur disposal — re-creating GPU defeats the memory saving).
  if (activeBackend === 'gpu' && !gpuBackend && !gpuAutoDisabled) {
    if (!gpuReinitSuppressed) {
      void tryReinitGpuBackend().catch(err =>
        logger.warn({ err }, 'Background GPU re-init failed')
      );
    }
    return generateEmbeddingsCpu(texts);
  }
  
  // Use GPU backend if active, available, ready, and not auto-disabled
  // The isReady() check prevents "GPU backend not initialized" errors after idle disposal
  if (activeBackend === 'gpu' && gpuBackend && gpuBackend.isReady() && !gpuAutoDisabled) {
    const startMs = Date.now();
    try {
      const result = await gpuBackend.generateEmbeddings(texts);
      embeddingLifecycleStats.gpuEmbedBatches++;
      const elapsedMs = Date.now() - startMs;
      
      // Success - reset failure counter
      consecutiveGpuFailures = 0;
      
      // Check for slow GPU (weak integrated graphics detection)
      // Scale threshold by batch size - larger batches take longer
      const scaledThreshold = GPU_SLOW_THRESHOLD_MS * Math.max(1, texts.length / 4);
      if (elapsedMs > scaledThreshold) {
        consecutiveSlowGpuBatches++;
        logger.warn(
          { elapsedMs, threshold: scaledThreshold, batchSize: texts.length, consecutiveSlow: consecutiveSlowGpuBatches },
          'GPU batch embedding slow - may indicate weak integrated graphics'
        );
        
        if (consecutiveSlowGpuBatches >= GPU_SLOW_COUNT_THRESHOLD) {
          autoDisableGpuDueToSlowness(elapsedMs);
        }
      } else {
        // Fast enough - reset slow counter
        consecutiveSlowGpuBatches = 0;
      }
      
      return result;
    } catch (err) {
      consecutiveGpuFailures++;
      logger.warn(
        { err, consecutiveFailures: consecutiveGpuFailures, threshold: GPU_FAILURE_THRESHOLD, batchSize: texts.length },
        'GPU batch embedding failed, falling back to CPU'
      );
      
      // Auto-disable GPU after too many consecutive failures
      if (consecutiveGpuFailures >= GPU_FAILURE_THRESHOLD) {
        autoDisableGpuDueToFailures();
      }
      
      // Fall through to CPU
    }
  }

  // Use CPU backend
  return generateEmbeddingsCpu(texts, 'gpu-error-fallback');
}

/**
 * Calculate cosine similarity between two embeddings
 * Note: This runs on main thread - it's lightweight math, not ML inference
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Check if the embedding service is ready
 */
export function isEmbeddingServiceReady(): boolean {
  if (activeBackend === 'gpu' && gpuBackend?.isReady()) return true;
  // Also ready if GPU was auto-disabled but CPU is available (fallback state)
  if (gpuAutoDisabled && isReady) return true;
  // CPU worker idle-disposed but service is available — will cold-start on demand
  if (isIdleDisposed && !serviceState.failed) return true;
  return isReady;
}

/**
 * Get the currently active embedding backend
 */
export function getActiveBackend(): EmbeddingBackend {
  return activeBackend;
}

/**
 * Check if GPU backend is available (even if not active)
 */
export function hasGpuSupport(): boolean {
  return gpuBackend !== null && gpuBackend.isReady();
}

/**
 * Log ONNX model file stats for debugging.
 * Called before model load attempts to help diagnose corruption issues.
 */
async function logModelFileStats(): Promise<void> {
  const cacheDir = getModelCacheDir();
  const modelPath = path.join(cacheDir, 'Xenova', 'bge-small-en-v1.5', 'onnx', 'model.onnx');

  try {
    const stats = await fs.promises.stat(modelPath);
    logger.debug(
      {
        path: modelPath,
        size: stats.size,
        mtime: stats.mtime.toISOString()
      },
      'ONNX model file stats before load'
    );
  } catch (err) {
    // Model file may not exist yet (first run) - this is expected
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ path: modelPath }, 'ONNX model file not found (will be downloaded on first use)');
    } else {
      // Unexpected error - log but don't block model loading
      logger.debug({ err, path: modelPath }, 'Failed to get ONNX model file stats');
    }
  }
}

/**
 * Preload the embedding model (call during app startup)
 * Uses a delay to avoid interfering with initial app load.
 * Tries GPU backend first if enabled, falls back to CPU.
 */
export async function preloadEmbeddingModel(settings?: AppSettings): Promise<void> {
  logger.info({ delayMs: MODEL_LOAD_DELAY_MS }, 'Scheduling embedding worker preload');
  await new Promise((resolve) => setTimeout(resolve, MODEL_LOAD_DELAY_MS));

  // Sync CPU idle disposal flag with settings at boot (env override still wins).
  updateCpuIdleDisposalFromSettings(settings);

  // Log model file stats for debugging (defense-in-depth after index health check)
  await logModelFileStats();

  const gpuEnabled = settings?.gpuEmbeddingEnabled !== false; // Default to true (opt-out)
  const hwAccelDisabled = app.commandLine.hasSwitch('disable-gpu');

  // Try GPU backend first if enabled and hardware acceleration is available
  if (gpuEnabled && !hwAccelDisabled) {
    try {
      logger.info('Attempting GPU embedding backend initialization');
      gpuBackend = new GpuEmbeddingBackend(getModelCacheDir());
      
      // Register disposal callback to handle idle disposal synchronization
      // Bound to this specific instance to prevent stale callback issues
      gpuBackend.onDisposal(createGpuIdleDisposalHandler(gpuBackend));
      
      const gpuAvailable = await gpuBackend.initialize();

      if (gpuAvailable) {
        activeBackend = 'gpu';
        recordGpuInit();
        logger.info('GPU embedding backend initialized successfully');
        return; // GPU ready, no need for CPU
      } else {
        logger.info('WebGPU not available, falling back to CPU backend');
        await gpuBackend.dispose();
        gpuBackend = null;
      }
    } catch (err) {
      logger.warn({ err }, 'GPU backend initialization failed, falling back to CPU');
      if (gpuBackend) {
        await gpuBackend.dispose();
        gpuBackend = null;
      }
    }
  } else {
    const reason = hwAccelDisabled
      ? 'hardware acceleration disabled'
      : 'GPU embeddings disabled in settings';
    logger.info({ reason }, 'Skipping GPU backend');
  }

  // Fall back to CPU backend
  activeBackend = 'cpu';
  try {
    await initializeCpuWorker('startup');
  } catch (error) {
    // Log full error details for debugging ONNX/transformers load failures
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(
      {
        err: error,
        errorMessage,
        errorStack,
        modelCacheDir: getModelCacheDir()
      },
      'Failed to preload embedding worker - will retry on first use'
    );
    serviceState.failed = false; // Allow retry on next call
  }
}

/**
 * Get embedding dimensions
 */
export function getEmbeddingDimensions(): number {
  return EMBEDDING_DIMS;
}

/**
 * Switch embedding backend at runtime based on settings.
 * Called when gpuEmbeddingEnabled setting changes.
 * Ensures safe disposal of GPU backend and fallback to CPU.
 */
export async function applyEmbeddingBackendFromSettings(settings: AppSettings): Promise<void> {
  const gpuEnabled = settings.gpuEmbeddingEnabled !== false;
  const hwAccelDisabled = app.commandLine.hasSwitch('disable-gpu');
  const shouldUseGpu = gpuEnabled && !hwAccelDisabled;

  // Sync the CPU idle disposal flag with current settings (env override always wins).
  const wasIdleDisposalOn = isCpuIdleDisposalEnabled();
  const isIdleDisposalOn = updateCpuIdleDisposalFromSettings(settings);
  if (wasIdleDisposalOn && !isIdleDisposalOn) {
    clearCpuIdleTimer();
  } else if (!wasIdleDisposalOn && isIdleDisposalOn && worker && isReady && !isDisposing && !isDisposed) {
    rescheduleCpuIdleTimer();
  }

  logger.info({ gpuEnabled, hwAccelDisabled, shouldUseGpu, currentBackend: activeBackend, cpuIdleDisposalEnabled: isIdleDisposalOn }, 'Applying embedding backend settings');

  // If GPU should be disabled and we have a GPU backend, dispose it
  if (!shouldUseGpu && gpuBackend) {
    logger.info('Disposing GPU backend due to settings change');
    // First switch to CPU to prevent any new operations from using GPU
    activeBackend = 'cpu';
    // Then dispose GPU backend
    const toDispose = gpuBackend;
    gpuBackend = null;
    try {
      await toDispose.dispose();
    } catch (err) {
      logger.warn({ err }, 'Error disposing GPU backend');
    }
    logger.info('GPU backend disposed, now using CPU');
    // Ensure CPU worker is ready
    try {
      await initializeCpuWorker('manual');
    } catch (err) {
      logger.warn({ err }, 'CPU worker initialization failed, will retry on first use');
      serviceState.failed = false;
    }
    return;
  }

  // If GPU should be enabled but we don't have a GPU backend, try to initialize it
  if (shouldUseGpu && !gpuBackend) {
    logger.info('Attempting to initialize GPU backend due to settings change');
    try {
      gpuBackend = new GpuEmbeddingBackend(getModelCacheDir());
      
      // Register disposal callback to handle idle disposal synchronization
      // Bound to this specific instance to prevent stale callback issues
      gpuBackend.onDisposal(createGpuIdleDisposalHandler(gpuBackend));
      
      const gpuAvailable = await gpuBackend.initialize();
      if (gpuAvailable) {
        activeBackend = 'gpu';
        recordGpuInit();
        logger.info('GPU backend initialized successfully via settings change');
        return;
      } else {
        logger.info('WebGPU not available, staying on CPU');
        await gpuBackend.dispose();
        gpuBackend = null;
      }
    } catch (err) {
      logger.warn({ err }, 'GPU backend initialization failed, staying on CPU');
      if (gpuBackend) {
        try {
          await gpuBackend.dispose();
        } catch {
          // Ignore
        }
        gpuBackend = null;
      }
    }
  }
}

/**
 * Set GPU worker throttling state.
 * Used to reduce CPU usage when app is in background.
 */
export function setGpuWorkerThrottling(enabled: boolean): void {
  if (gpuBackend) {
    gpuBackend.setThrottling(enabled);
  }
}

/**
 * Dispose GPU backend when app loses focus (blur).
 * Frees ~811MB GPU memory while user is in another app (e.g., Zoom).
 * CPU fallback handles any embedding requests while GPU is disposed.
 *
 * Follows the same disposal pattern as `createGpuIdleDisposalHandler()`:
 * - Nulls gpuBackend reference
 * - Keeps activeBackend = 'gpu' (enables lazy re-init on focus return)
 * - Relies on lazy CPU worker init on the next actual fallback request
 *
 * Safe to call when GPU is already disposed or disposing (no-op).
 */
export function disposeGpuBackendOnBlur(): void {
  // Suppress background GPU re-init while blurred even if the backend already
  // idled out — otherwise background indexing can recreate the GPU surface.
  gpuReinitSuppressed = true;

  // Guard: nothing to dispose
  if (!gpuBackend) return;

  // Guard: GPU was auto-disabled due to errors — already on CPU-only
  if (gpuAutoDisabled) return;

  // Guard: service already fully disposed (shutdown)
  if (isDisposed) return;

  logger.info('Disposing GPU backend on app blur to free memory');

  // Fire-and-forget disposal — gpuBackend.dispose() handles its own drain/cleanup.
  // We capture the reference first, then null the module-level pointer so no new
  // requests route to this backend while it drains.
  const toDispose = gpuBackend;
  gpuBackend = null;
  // IMPORTANT: Keep activeBackend = 'gpu' — same pattern as idle disposal.
  // This enables lazy re-initialization on focus return or next embed request.

  void toDispose.dispose().catch(err => {
    logger.warn({ err }, 'GPU backend disposal on blur failed (non-fatal)');
  });
  recordGpuBlurIdleDispose();

  // Reset GPU failure/slow counters — blur disposal is intentional, not an error
  consecutiveGpuFailures = 0;
  consecutiveSlowGpuBatches = 0;

  // Track lifecycle metrics
  gpuLifecycleMetrics.blurDisposalCount++;
  gpuLifecycleMetrics.lastBlurDisposalAt = Date.now();

  getErrorReporter().addBreadcrumb({
    category: 'embedding',
    message: 'GPU backend disposed on blur — will re-init on focus',
    level: 'info',
  });

  // Lazy init: blur means the user left Rebel; first embed on return will init the CPU worker on demand
  // (see generateEmbeddingCpu fallback at lines 1217, 1235, 1358, 1607, 1660).
  // Restore eager behaviour with REBEL_DISABLE_LAZY_CPU_WARMUP=1 if user reports first-request latency regression.
  if (process.env.REBEL_DISABLE_LAZY_CPU_WARMUP === '1') {
    void initializeCpuWorker('blur-fallback').catch(err => {
      logger.warn({ err }, 'CPU worker initialization failed after blur GPU disposal');
    });
  }
}

/**
 * Proactively warm up GPU backend when app regains focus.
 * Triggers lazy re-initialization in the background so GPU is ready
 * for the next embedding request. CPU serves requests in the meantime.
 *
 * No-op when:
 * - activeBackend is 'cpu' (user or system chose CPU-only)
 * - gpuBackend already exists (no warm-up needed)
 * - gpuAutoDisabled (GPU failed too many times)
 * - Service is disposed (shutdown)
 */
export function warmUpGpuBackend(): void {
  // Lift blur-disposal re-init suppression — focus means user is back, GPU is welcome.
  // Must happen before guards: if an in-flight re-init completed while blurred,
  // gpuBackend is already present and the guard below would skip clearing suppression.
  gpuReinitSuppressed = false;

  // Guard: not in GPU mode — user/system chose CPU
  if (activeBackend !== 'gpu') return;

  // Guard: GPU backend already exists and running
  if (gpuBackend) return;

  // Guard: GPU permanently disabled due to repeated failures
  if (gpuAutoDisabled) return;

  // Guard: service fully disposed (shutdown)
  if (isDisposed) return;

  logger.info('Warming up GPU backend on app focus');

  // Track lifecycle metrics
  gpuLifecycleMetrics.focusWarmUpCount++;
  gpuLifecycleMetrics.lastFocusWarmUpAt = Date.now();

  // Fire-and-forget re-initialization — CPU handles requests while GPU initializes
  void tryReinitGpuBackend().catch(err => {
    logger.warn({ err }, 'GPU warm-up on focus failed (non-fatal, CPU continues)');
  });
}

/**
 * Get GPU lifecycle metrics for diagnostics.
 * Returns a copy to prevent external mutation.
 */
export function getGpuLifecycleMetrics(): GpuLifecycleMetrics {
  return { ...gpuLifecycleMetrics };
}

// ── Test helpers (prefixed with _ to indicate internal/test-only use) ──

/**
 * @internal Test-only: set GPU backend state for unit tests.
 */
export function _setGpuBackendForTesting(backend: GpuEmbeddingBackend | null): void {
  gpuBackend = backend;
}

/**
 * @internal Test-only: set active backend for unit tests.
 */
export function _setActiveBackendForTesting(backend: 'gpu' | 'cpu'): void {
  activeBackend = backend;
}

/**
 * @internal Test-only: set gpuAutoDisabled flag for unit tests.
 */
export function _setGpuAutoDisabledForTesting(disabled: boolean): void {
  gpuAutoDisabled = disabled;
}

/**
 * @internal Test-only: set isDisposed flag for unit tests.
 */
export function _setIsDisposedForTesting(disposed: boolean): void {
  isDisposed = disposed;
}

/**
 * @internal Test-only: reset GPU lifecycle metrics for clean test state.
 */
export function _resetGpuLifecycleMetricsForTesting(): void {
  gpuLifecycleMetrics.blurDisposalCount = 0;
  gpuLifecycleMetrics.focusWarmUpCount = 0;
  gpuLifecycleMetrics.lastBlurDisposalAt = null;
  gpuLifecycleMetrics.lastFocusWarmUpAt = null;
  gpuReinitSuppressed = false;
  embeddingLifecycleStats.cpuWorkerSpawns = 0;
  embeddingLifecycleStats.gpuBlurIdleDispositions = 0;
  embeddingLifecycleStats.gpuInits = 0;
  embeddingLifecycleStats.cpuEmbedBatches = 0;
  embeddingLifecycleStats.gpuEmbedBatches = 0;
  embeddingLifecycleStats.onnxIntraOpThreads = resolveIntraOpThreads();
  embeddingLifecycleStats.firstCpuInitReason = null;
  embeddingLifecycleStats.lastCpuInitReason = null;
  embeddingLifecycleStats.cpuInitReasonCounts = {
    'startup': 0,
    'blur-fallback': 0,
    'idle-fallback': 0,
    'gpu-error-fallback': 0,
    'manual': 0,
  };
  embeddingLifecycleStats.lastInitAt = null;
  embeddingLifecycleStats.lastDisposeAt = null;
}

// ── CPU idle disposal test helpers ──

/**
 * @internal Test-only: get CPU idle disposal state for assertions.
 */
export function _getCpuIdleStateForTesting(): {
  isIdleDisposed: boolean;
  isDisposing: boolean;
  cpuLastActivityMs: number;
  pendingCpuRequestCount: number;
  timerActive: boolean;
} {
  return {
    isIdleDisposed,
    isDisposing,
    cpuLastActivityMs,
    pendingCpuRequestCount,
    timerActive: cpuIdleTimer !== null,
  };
}

/**
 * @internal Test-only: override CPU idle timeout for fast tests.
 */
export function _setCpuIdleTimeoutForTesting(ms: number): void {
  CPU_IDLE_TIMEOUT_MS = ms;
}

/**
 * @internal Test-only: manually trigger the CPU idle check.
 * Fires the idle timer callback immediately if conditions are met.
 */
export function _triggerCpuIdleCheckForTesting(): void {
  clearCpuIdleTimer();
  if (
    worker &&
    isReady &&
    !isDisposing &&
    !isDisposed &&
    pendingCpuRequestCount === 0
  ) {
    fireAndForget(disposeCpuWorkerForIdle(), 'embeddingService.line2282');
  }
}

/**
 * Start idle monitoring for GPU worker.
 * After idle timeout, disposes GPU backend to save resources.
 */
export function startGpuIdleMonitoring(): void {
  if (gpuBackend) {
    // For now, this is a placeholder - actual timer management
    // happens via throttling (Phase 1). Full idle disposal
    // would require more coordination. Logged for future.
    logger.debug('GPU idle monitoring started (via throttling)');
  }
}

/**
 * Dispose of the embedding service to free memory
 */
export async function disposeEmbeddingService(): Promise<void> {
  // REBEL-4X: Set disposed flag immediately to prevent any new worker creation
  isDisposed = true;

  // Clear CPU idle disposal state
  clearCpuIdleTimer();
  isIdleDisposed = false;
  isDisposing = false;

  // Dispose GPU backend
  if (gpuBackend) {
    await gpuBackend.dispose();
    gpuBackend = null;
    logger.info('GPU embedding backend disposed');
  }

  // REBEL-HP: Reject pending callbacks/requests with ShutdownError to prevent Sentry noise
  // The global unhandledRejection handler filters ShutdownError during graceful shutdown
  notifyModelReadyCallbacks(new ShutdownError('Embedding service disposed'));
  rejectAllPending(new ShutdownError('Embedding service disposed'));

  // Dispose CPU worker
  if (worker) {
    // Wait for disposed ack instead of arbitrary timeout.
    // This ensures worker has finished cleanup before termination.
    const w = worker; // Capture reference for cleanup
    const disposePromise = new Promise<void>((resolve) => {
      // eslint-disable-next-line prefer-const -- assigned after cleanup closure captures it
      let timeoutId: NodeJS.Timeout | undefined;

      function cleanup() {
        if (timeoutId) clearTimeout(timeoutId);
        w?.off('message', onMessage);
        w?.off('exit', onExit);
      }

      function onMessage(response: { type: string }) {
        if (response.type === 'disposed') {
          cleanup();
          resolve();
        }
      }

      function onExit(_code?: number) {
        cleanup();
        resolve();
      }

      // Register listeners BEFORE posting dispose to avoid race
      w?.on('message', onMessage);
      w?.on('exit', onExit);

      // Timeout fallback in case worker hangs (5s to allow slow operations)
      timeoutId = setTimeout(() => {
        logger.warn('Embedding worker dispose timeout - forcing termination');
        cleanup();
        resolve();
      }, 5000);
    });

    w.postMessage({ type: 'dispose' });
    await disposePromise;
    try {
      intentionalWorkerShutdown = true;
      w.kill();
    } catch {
      // Ignore
    }
    worker = null;
    isReady = false;
    initPromise = null;
    // Reset service state on disposal
    serviceState.ready = false;
    serviceState.failed = false;
    serviceState.failedDueToCrash = false;
    serviceState.attempts = 0;
    serviceState.lastError = null;
    serviceState.lastAttemptAt = null;
    logger.info('CPU embedding worker disposed');
  }

  activeBackend = 'cpu';
}
