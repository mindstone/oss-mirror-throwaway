/**
 * Local STT Model Manager
 *
 * Handles downloading, verifying, and managing local speech-to-text models.
 * Designed for future extensibility with multiple model versions and types.
 *
 * Model sources:
 * - macOS (CoreML): HuggingFace FluidInference/parakeet-tdt-0.6b-v3-coreml
 * - Windows (ONNX): HuggingFace istupakov/parakeet-tdt-0.6b-v3-onnx (future)
 *
 * Download strategy:
 * - Uses staging directory for atomic installs (download to .staging, rename on success)
 * - Per-file retry with exponential backoff
 * - Adaptive timeouts based on file size
 * - Checksum verification for large files
 */

import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import type { LocalSttModelStatus } from '../../shared/ipc/channels/localStt';

const log = createScopedLogger({ service: 'LocalSttModelManager' });

/**
 * Marker stamped on an Error object after it has been captured to the error
 * reporter. Prevents an outer catch from re-capturing the same error under a
 * less specific component tag (see `migrateLegacyModelPaths`).
 *
 * Using a Symbol (not a string key) avoids colliding with anything the thrown
 * value might legitimately carry. Tests assert on `component` tags only; they
 * don't observe this marker directly.
 */
const LOCAL_STT_CAPTURED = Symbol('localStt.captured');

function markCaptured(err: unknown): void {
  if (err && typeof err === 'object') {
    try {
      (err as Record<symbol, unknown>)[LOCAL_STT_CAPTURED] = true;
    } catch {
      // Frozen/sealed object — ignore; worst case is we re-capture once.
    }
  }
}

/**
 * True if `err` was already passed through `reportLocalSttError()` at a more
 * specific stage. Callers in outer catches use this to avoid double-capture
 * after a downstream `throw`.
 */
export function isLocalSttCaptured(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      (err as Record<symbol, unknown>)[LOCAL_STT_CAPTURED]
  );
}

/**
 * Shared Sentry capture helper for local-STT failure paths.
 *
 * Additive to structured logging — every caller should still emit a
 * `log.warn`/`log.error` alongside this so local log files retain context.
 * Never throws: if the error reporter is unavailable or throws during
 * capture, we log a warning and continue (avoids turning telemetry gaps
 * into hard failures).
 *
 * After a successful capture, the error is stamped with a Symbol marker so
 * outer catches can detect it and avoid double-reporting the same underlying
 * failure under a less specific `component` tag. Inner catches get the
 * precise stage label; outer catches only fire for genuinely new failures.
 *
 * Component tags used across local-STT:
 * - `migrate-inspect-new-path` — inspecting existing FluidAudio install fails
 * - `migrate-copy-fallback`   — cross-device copy fallback fails
 * - `migrate-unknown`         — outer catch in migrateLegacyModelPaths
 * - `cli-spawn-error`         — fluidaudiocli failed to spawn
 * - `cli-exit-nonzero`        — fluidaudiocli exited with non-zero code
 * - `cli-timeout`             — fluidaudiocli exceeded the 60s timeout
 *
 * See docs-private/investigations/260422_local_parakeet_still_not_working_daniel_kilger.md.
 */
export function reportLocalSttError(
  err: unknown,
  component: string,
  extras?: Record<string, unknown>
): void {
  try {
    getErrorReporter().captureException(err, {
      tags: { area: 'local-stt', component },
      extras,
    });
    markCaptured(err);
  } catch (captureErr) {
    // Wave 2d (W2D-6) sentinel: re-throw KnownConditionGuardError so the
    // Wave 2c deterministic-CI-failure contract (KNOWN_CONDITION_GUARD_LEVEL=throw
    // in NODE_ENV=test) survives this fail-safe wrapper. Production behaviour
    // is unchanged (env-knob unset → warn; throw-mode outside test → warn).
    // See docs/plans/260503_wave2d_layer2_contract_completion.md (Wave 2d).
    if (
      process.env.NODE_ENV === 'test' &&
      (captureErr as { name?: string } | null)?.name === 'KnownConditionGuardError'
    ) {
      throw captureErr;
    }
    log.warn(
      { err: captureErr instanceof Error ? captureErr.message : String(captureErr), component },
      'Failed to capture local-STT error to error reporter'
    );
  }
}

// HuggingFace base URL for model downloads
const HF_BASE_URL = 'https://huggingface.co';

// Download configuration
const DOWNLOAD_CONFIG = {
  /** Base socket inactivity timeout in ms (for small files) */
  baseTimeoutMs: 60_000,
  /** Additional timeout per MB of expected file size */
  timeoutPerMbMs: 2_000,
  /** Maximum timeout for any single file */
  maxTimeoutMs: 600_000, // 10 minutes
  /** Number of retry attempts per file */
  maxRetries: 3,
  /** Base delay for exponential backoff (ms) */
  retryBaseDelayMs: 1_000,
  /** Maximum delay between retries (ms) */
  retryMaxDelayMs: 30_000,
};

/**
 * Model file definition with download URL and optional checksum
 */
interface ModelFile {
  /** Relative path within the model directory */
  path: string;
  /** HuggingFace URL path (after repo name) */
  hfPath: string;
  /** Expected SHA256 checksum (LFS oid for large files) */
  sha256?: string;
  /** Expected file size in bytes */
  sizeBytes?: number;
  /** Whether this is a directory (for .mlmodelc bundles) */
  isDirectory?: boolean;
}

/**
 * Model configuration - designed for future versioning
 */
interface ModelConfig {
  /** Model identifier (e.g., 'parakeet-v3') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Version string */
  version: string;
  /** HuggingFace repository path */
  hfRepo: string;
  /** Local directory name under app models folder */
  localDir: string;
  /** Expected total size in bytes (approximate) */
  totalSizeBytes: number;
  /** Files to download */
  files: ModelFile[];
  /** License identifier */
  license: string;
}

/**
 * Platform-specific model configurations
 * Future-proofed for multiple models and versions
 */
const MODELS: Record<string, ModelConfig> = {
  'darwin:parakeet-v3': {
    id: 'parakeet-v3',
    name: 'Parakeet TDT 0.6B V3',
    version: '3.0.0',
    hfRepo: 'FluidInference/parakeet-tdt-0.6b-v3-coreml',
    localDir: 'parakeet-tdt-0.6b-v3-coreml',
    totalSizeBytes: 482_000_000, // ~482 MB total
    license: 'CC-BY-4.0',
    files: [
      // Vocabulary file
      {
        path: 'parakeet_vocab.json',
        hfPath: 'parakeet_vocab.json',
        sha256: '7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735',
      },
      // Encoder model bundle
      {
        path: 'Encoder.mlmodelc',
        hfPath: 'Encoder.mlmodelc',
        isDirectory: true,
      },
      {
        path: 'Encoder.mlmodelc/weights/weight.bin',
        hfPath: 'Encoder.mlmodelc/weights/weight.bin',
        sha256: 'e2020f323703477a5b21d7c2d282c403e371afb5962e79877e3033e73ba6f421',
        sizeBytes: 445_187_200,
      },
      {
        path: 'Encoder.mlmodelc/model.mil',
        hfPath: 'Encoder.mlmodelc/model.mil',
      },
      {
        path: 'Encoder.mlmodelc/metadata.json',
        hfPath: 'Encoder.mlmodelc/metadata.json',
      },
      {
        path: 'Encoder.mlmodelc/coremldata.bin',
        hfPath: 'Encoder.mlmodelc/coremldata.bin',
      },
      {
        path: 'Encoder.mlmodelc/analytics/coremldata.bin',
        hfPath: 'Encoder.mlmodelc/analytics/coremldata.bin',
      },
      // Decoder model bundle
      {
        path: 'Decoder.mlmodelc',
        hfPath: 'Decoder.mlmodelc',
        isDirectory: true,
      },
      {
        path: 'Decoder.mlmodelc/weights/weight.bin',
        hfPath: 'Decoder.mlmodelc/weights/weight.bin',
        sha256: '48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41',
        sizeBytes: 23_604_992,
      },
      {
        path: 'Decoder.mlmodelc/model.mil',
        hfPath: 'Decoder.mlmodelc/model.mil',
      },
      {
        path: 'Decoder.mlmodelc/metadata.json',
        hfPath: 'Decoder.mlmodelc/metadata.json',
      },
      {
        path: 'Decoder.mlmodelc/coremldata.bin',
        hfPath: 'Decoder.mlmodelc/coremldata.bin',
      },
      {
        path: 'Decoder.mlmodelc/analytics/coremldata.bin',
        hfPath: 'Decoder.mlmodelc/analytics/coremldata.bin',
      },
      // JointDecision model bundle
      {
        path: 'JointDecision.mlmodelc',
        hfPath: 'JointDecision.mlmodelc',
        isDirectory: true,
      },
      {
        path: 'JointDecision.mlmodelc/weights/weight.bin',
        hfPath: 'JointDecision.mlmodelc/weights/weight.bin',
        sha256: '4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e',
        sizeBytes: 12_642_764,
      },
      {
        path: 'JointDecision.mlmodelc/model.mil',
        hfPath: 'JointDecision.mlmodelc/model.mil',
      },
      {
        path: 'JointDecision.mlmodelc/metadata.json',
        hfPath: 'JointDecision.mlmodelc/metadata.json',
      },
      {
        path: 'JointDecision.mlmodelc/coremldata.bin',
        hfPath: 'JointDecision.mlmodelc/coremldata.bin',
      },
      {
        path: 'JointDecision.mlmodelc/analytics/coremldata.bin',
        hfPath: 'JointDecision.mlmodelc/analytics/coremldata.bin',
      },
      // Preprocessor model bundle
      {
        path: 'Preprocessor.mlmodelc',
        hfPath: 'Preprocessor.mlmodelc',
        isDirectory: true,
      },
      {
        path: 'Preprocessor.mlmodelc/weights/weight.bin',
        hfPath: 'Preprocessor.mlmodelc/weights/weight.bin',
        sha256: '129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea',
        sizeBytes: 491_072,
      },
      {
        path: 'Preprocessor.mlmodelc/model.mil',
        hfPath: 'Preprocessor.mlmodelc/model.mil',
      },
      {
        path: 'Preprocessor.mlmodelc/metadata.json',
        hfPath: 'Preprocessor.mlmodelc/metadata.json',
      },
      {
        path: 'Preprocessor.mlmodelc/coremldata.bin',
        hfPath: 'Preprocessor.mlmodelc/coremldata.bin',
      },
      {
        path: 'Preprocessor.mlmodelc/analytics/coremldata.bin',
        hfPath: 'Preprocessor.mlmodelc/analytics/coremldata.bin',
      },
    ],
  },
  // Windows ONNX model - uses sherpa-onnx int8 quantized model
  // SHA-256 hashes not yet pinned — run a successful download and check logs for computed hashes
  'win32:parakeet-v3': {
    id: 'parakeet-v3',
    name: 'Parakeet TDT 0.6B V3 (ONNX)',
    version: '3.0.0',
    hfRepo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    localDir: 'parakeet-tdt-0.6b-v3-onnx',
    totalSizeBytes: 670_000_000, // approximate, used for progress bar
    license: 'CC-BY-4.0',
    files: [
      {
        path: 'encoder.int8.onnx',
        hfPath: 'encoder.int8.onnx',
        sizeBytes: 652_000_000,
      },
      {
        path: 'decoder.int8.onnx',
        hfPath: 'decoder.int8.onnx',
        sizeBytes: 12_000_000,
      },
      {
        path: 'joiner.int8.onnx',
        hfPath: 'joiner.int8.onnx',
        sizeBytes: 6_400_000,
      },
      {
        path: 'tokens.txt',
        hfPath: 'tokens.txt',
        sizeBytes: 94_000,
      },
    ],
  },
  // Moonshine Base ONNX model — cross-platform (macOS + Windows)
  // Uses HuggingFace ONNX export format (encoder + merged decoder)
  // When upgrading model version, change localDir to a new versioned name (e.g., 'moonshine-base-v2-onnx')
  'darwin:moonshine-base': {
    id: 'moonshine-base',
    name: 'Moonshine Base',
    version: '1.0.0',
    hfRepo: 'onnx-community/moonshine-base-ONNX',
    localDir: 'moonshine-base-onnx',
    totalSizeBytes: 250_792_802,
    license: 'MIT',
    files: [
      {
        path: 'encoder_model.onnx',
        hfPath: 'onnx/encoder_model.onnx',
        sha256: '153e128e7abd64a74ee47f2c3f585c3171c4d46cbb368b032827934c4e01e779',
        sizeBytes: 80_818_781,
      },
      {
        path: 'decoder_model_merged.onnx',
        hfPath: 'onnx/decoder_model_merged.onnx',
        sha256: '58778763ca8438963190244d6b26572bdca2cedec56a4b91e828f3f2d69ef3c5',
        sizeBytes: 166_211_345,
      },
      {
        path: 'tokenizer.json',
        hfPath: 'tokenizer.json',
        sha256: '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f',
        sizeBytes: 3_761_754,
      },
      {
        path: 'config.json',
        hfPath: 'config.json',
        sha256: 'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1',
        sizeBytes: 922,
      },
    ],
  },
  'win32:moonshine-base': {
    id: 'moonshine-base',
    name: 'Moonshine Base',
    version: '1.0.0',
    hfRepo: 'onnx-community/moonshine-base-ONNX',
    localDir: 'moonshine-base-onnx',
    totalSizeBytes: 250_792_802,
    license: 'MIT',
    files: [
      {
        path: 'encoder_model.onnx',
        hfPath: 'onnx/encoder_model.onnx',
        sha256: '153e128e7abd64a74ee47f2c3f585c3171c4d46cbb368b032827934c4e01e779',
        sizeBytes: 80_818_781,
      },
      {
        path: 'decoder_model_merged.onnx',
        hfPath: 'onnx/decoder_model_merged.onnx',
        sha256: '58778763ca8438963190244d6b26572bdca2cedec56a4b91e828f3f2d69ef3c5',
        sizeBytes: 166_211_345,
      },
      {
        path: 'tokenizer.json',
        hfPath: 'tokenizer.json',
        sha256: '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f',
        sizeBytes: 3_761_754,
      },
      {
        path: 'config.json',
        hfPath: 'config.json',
        sha256: 'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1',
        sizeBytes: 922,
      },
    ],
  },
};

/** Required weight files that must exist (not just directories) for valid installation */
const REQUIRED_WEIGHT_FILES_DARWIN = [
  'parakeet_vocab.json',
  'Encoder.mlmodelc/weights/weight.bin',
  'Decoder.mlmodelc/weights/weight.bin',
  'JointDecision.mlmodelc/weights/weight.bin',
  'Preprocessor.mlmodelc/weights/weight.bin',
];

/** Required ONNX model files for Windows */
const REQUIRED_FILES_WIN32 = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
];

/** Required ONNX model files for Moonshine Base (all platforms) */
const REQUIRED_FILES_MOONSHINE = [
  'encoder_model.onnx',
  'decoder_model_merged.onnx',
  'tokenizer.json',
  'config.json',
];

interface DownloadState {
  inProgress: boolean;
  abortController: AbortController | null;
  downloadedBytes: number;
  totalBytes: number;
  currentFile: string;
  /** Unique ID to prevent race conditions between cancel and new download */
  downloadId: number;
}

/**
 * Calculate adaptive timeout based on expected file size
 */
function calculateTimeout(fileSizeBytes?: number): number {
  const sizeMb = (fileSizeBytes ?? 0) / (1024 * 1024);
  const timeout = DOWNLOAD_CONFIG.baseTimeoutMs + sizeMb * DOWNLOAD_CONFIG.timeoutPerMbMs;
  return Math.min(timeout, DOWNLOAD_CONFIG.maxTimeoutMs);
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = DOWNLOAD_CONFIG.retryBaseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // Add up to 1s of jitter
  return Math.min(exponentialDelay + jitter, DOWNLOAD_CONFIG.retryMaxDelayMs);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class LocalSttModelManager {
  /** Per-model download states (keyed by modelId) */
  private downloadStates = new Map<string, DownloadState>();

  /** Counter for generating unique download IDs */
  private nextDownloadId = 1;

  /** Per-model throttle state for IPC progress sends */
  private lastProgressSendTimes = new Map<string, number>();

  /** Per-model pending progress events (throttled) */
  private pendingProgressMap = new Map<string, {
    mainWindow: BrowserWindow | null;
    progress: {
      modelId: string;
      progress: number;
      downloadedBytes: number;
      totalBytes: number;
      status: 'downloading' | 'extracting' | 'complete' | 'error' | 'cancelled';
      error?: string;
    };
  }>();

  /** Get or create a download state for a model */
  private getDownloadState(modelId: string): DownloadState {
    let state = this.downloadStates.get(modelId);
    if (!state) {
      state = {
        inProgress: false,
        abortController: null,
        downloadedBytes: 0,
        totalBytes: 0,
        currentFile: '',
        downloadId: 0,
      };
      this.downloadStates.set(modelId, state);
    }
    return state;
  }

  /**
   * Get the model config for a given modelId and the current platform.
   * Defaults to 'parakeet-v3' for backward compatibility.
   */
  private getModelConfig(modelId: string = 'parakeet-v3'): ModelConfig | null {
    const platform = process.platform;
    const key = `${platform}:${modelId}`;
    return MODELS[key] ?? null;
  }

  /**
   * Get the model directory path.
   *
   * Most models live under our app's userData directory, but the macOS Parakeet V3
   * model MUST live at FluidAudio's default location because the bundled
   * `fluidaudiocli` binary has that path hard-coded as its model search directory
   * — it does not accept a `--models` argument on the `transcribe` subcommand.
   * If models are downloaded anywhere else, the CLI silently attempts to fetch
   * its own copy from HuggingFace on first use, which exceeds the 60 s timeout
   * and appears to users as "transcription timed out after X seconds". See
   * FOX-3081 for the full investigation.
   */
  getModelPath(modelId: string = 'parakeet-v3'): string {
    const config = this.getModelConfig(modelId);
    if (!config) {
      throw new Error(`Local STT model '${modelId}' not supported on ${process.platform}`);
    }
    if (process.platform === 'darwin' && modelId === 'parakeet-v3') {
      // ~/Library/Application Support/FluidAudio/Models/<localDir>
      return path.join(app.getPath('appData'), 'FluidAudio', 'Models', config.localDir);
    }
    return path.join(app.getPath('userData'), 'models', config.localDir);
  }

  /**
   * Legacy model path used prior to the FluidAudio-compatible fix.
   * Returned only for darwin:parakeet-v3 so we can migrate existing installs.
   */
  private getLegacyModelPath(modelId: string): string | null {
    if (process.platform !== 'darwin' || modelId !== 'parakeet-v3') {
      return null;
    }
    const config = this.getModelConfig(modelId);
    if (!config) return null;
    return path.join(app.getPath('userData'), 'models', config.localDir);
  }

  /**
   * One-time migration: move Parakeet V3 model files from the legacy userData
   * path to the FluidAudio-compatible path.
   *
   * Safe on every startup: no-ops if the legacy path is absent or if the new
   * path already has files (we never overwrite a working install).
   *
   * Called from the process startup code path alongside cleanupStaleStaging().
   */
  migrateLegacyModelPaths(): void {
    const modelId = 'parakeet-v3';
    const legacyPath = this.getLegacyModelPath(modelId);
    if (!legacyPath) return; // Not darwin:parakeet-v3

    const newPath = this.getModelPath(modelId);
    const userDataPath = app.getPath('userData');

    // Safety: only touch paths inside our userData (legacy) or FluidAudio's
    // Application Support subdirectory (new) — never anything else.
    const appDataPath = app.getPath('appData');
    if (!legacyPath.startsWith(userDataPath)) {
      log.error({ legacyPath }, 'Refusing legacy STT migration outside userData');
      return;
    }
    if (!newPath.startsWith(appDataPath)) {
      log.error({ newPath }, 'Refusing legacy STT migration to path outside appData');
      return;
    }

    // Nothing to migrate
    if (!fs.existsSync(legacyPath)) return;

    // If the new path already has a *complete* install, clean up the old copy.
    // IMPORTANT: Do NOT treat "any non-empty directory" as a valid install.
    // v0.4.27 users may have partial files here from the CLI's failed
    // HuggingFace download attempts — deleting the good legacy copy would
    // brick their install. We verify required model files before deciding.
    if (fs.existsSync(newPath)) {
      try {
        const requiredFiles = this.getRequiredFiles(modelId);
        const newPathComplete = requiredFiles.every(f => {
          const p = path.join(newPath, f);
          try { return fs.existsSync(p) && !fs.statSync(p).isDirectory(); } catch { return false; }
        });
        if (newPathComplete) {
          log.info({ legacyPath, newPath }, 'New STT model path has complete install; removing legacy copy');
          fs.rmSync(legacyPath, { recursive: true, force: true });
          return;
        }
        // New path exists but is incomplete — wipe it so we can migrate the
        // good legacy copy into its place.
        log.warn({ legacyPath, newPath }, 'New STT model path has incomplete install (likely partial CLI download from v0.4.27); replacing with legacy copy');
        fs.rmSync(newPath, { recursive: true, force: true });
      } catch (err) {
        log.warn({ err, newPath }, 'Failed to inspect existing new STT model path; skipping migration');
        reportLocalSttError(err, 'migrate-inspect-new-path', {
          legacyPath,
          newPath,
          stage: 'inspect-new-path',
        });
        return;
      }
    }

    try {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      try {
        fs.renameSync(legacyPath, newPath);
        log.info({ from: legacyPath, to: newPath }, 'Migrated local STT model to FluidAudio-compatible path (rename)');
      } catch (renameErr) {
        // Cross-device or permission error — fall back to recursive copy + delete.
        // This is an expected path (e.g. EXDEV when userData and appData live on
        // different volumes) and NOT captured to Sentry; only the copy-fallback
        // failure below is captured.
        log.info({ err: renameErr instanceof Error ? renameErr.message : String(renameErr) }, 'Rename failed during STT model migration; falling back to copy');
        try {
          fs.cpSync(legacyPath, newPath, { recursive: true });
          fs.rmSync(legacyPath, { recursive: true, force: true });
          log.info({ from: legacyPath, to: newPath }, 'Migrated local STT model to FluidAudio-compatible path (copy)');
        } catch (copyErr) {
          // Copy failed mid-way — clean up the partial new path so the next
          // startup doesn't mistake it for a valid install and delete legacy.
          log.warn({ err: copyErr instanceof Error ? copyErr.message : String(copyErr) }, 'Copy fallback failed during STT model migration; cleaning up partial destination');
          reportLocalSttError(copyErr, 'migrate-copy-fallback', {
            legacyPath,
            newPath,
            stage: 'copy-fallback',
          });
          try { fs.rmSync(newPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          throw copyErr;
        }
      }
      // Clean up legacy staging directory if it exists (orphaned from pre-fix downloads)
      const legacyStagingPath = legacyPath + '.staging';
      if (fs.existsSync(legacyStagingPath)) {
        try {
          fs.rmSync(legacyStagingPath, { recursive: true, force: true });
          log.debug({ legacyStagingPath }, 'Cleaned up legacy staging directory during migration');
        } catch { /* best-effort cleanup */ }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), legacyPath, newPath },
        'Failed to migrate legacy STT model path — user may need to re-download the model'
      );
      // Avoid double-capture: if a downstream stage (e.g. copy-fallback)
      // already reported this same error with a more specific component tag,
      // don't clone it as `migrate-unknown`. One Sentry event per root
      // failure, tagged at the deepest stage we have context for.
      if (!isLocalSttCaptured(err)) {
        reportLocalSttError(err, 'migrate-unknown', {
          legacyPath,
          newPath,
          stage: 'outer-catch',
        });
      }
    }
  }

  /**
   * Get the staging directory path for downloads in progress
   */
  private getStagingPath(modelId: string = 'parakeet-v3'): string {
    return this.getModelPath(modelId) + '.staging';
  }

  /**
   * Returns true if the given path is within one of our managed roots:
   *  - `{userData}/models/` — legacy & non-darwin model storage
   *  - `{appData}/FluidAudio/Models/` — FluidAudio CLI search path used by
   *    darwin:parakeet-v3 (see getModelPath for why we need it there)
   *
   * Used by delete/cleanup operations to avoid ever touching paths outside
   * locations we own. Kept defensive: we only allow these two roots, never a
   * bare parent like `{userData}` or `{appData}` alone.
   */
  private isSafeManagedPath(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    const userDataModels = path.resolve(app.getPath('userData'), 'models');
    const fluidAudioModels = path.resolve(app.getPath('appData'), 'FluidAudio', 'Models');
    return (
      resolved === userDataModels ||
      resolved.startsWith(userDataModels + path.sep) ||
      resolved === fluidAudioModels ||
      resolved.startsWith(fluidAudioModels + path.sep)
    );
  }

  /**
   * Check if the model is installed and valid.
   * Performs deep verification - checks actual files, not just directories.
   * @param modelId Model to check (defaults to 'parakeet-v3' for backward compatibility)
   */
  async getStatus(modelId: string = 'parakeet-v3'): Promise<LocalSttModelStatus> {
    const config = this.getModelConfig(modelId);

    if (!config) {
      return {
        installed: false,
        downloading: false,
        error: `Local STT model '${modelId}' not supported on ${process.platform}`,
        modelId,
      };
    }

    const modelPath = this.getModelPath(modelId);
    const downloadState = this.getDownloadState(modelId);

    // Check if downloading
    if (downloadState.inProgress) {
      const progress = downloadState.totalBytes > 0
        ? Math.round((downloadState.downloadedBytes / downloadState.totalBytes) * 100)
        : 0;
      return {
        installed: false,
        downloading: true,
        downloadProgress: progress,
        path: modelPath,
        modelId,
      };
    }

    // Check if model directory exists
    if (!fs.existsSync(modelPath)) {
      return {
        installed: false,
        downloading: false,
        path: modelPath,
        modelId,
      };
    }

    // Deep verification: check required files based on model type
    const requiredFiles = this.getRequiredFiles(modelId);
    const missingFiles: string[] = [];
    for (const file of requiredFiles) {
      const filePath = path.join(modelPath, file);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        missingFiles.push(file);
      }
    }

    if (missingFiles.length > 0) {
      const missingComponents = [...new Set(missingFiles.map(f => {
        const parts = f.split('/');
        return parts[0];
      }))];
      log.warn(
        { missingFiles, missingComponents, modelPath, modelId },
        'Local STT model incomplete - required files are missing. User should re-download.'
      );
      return {
        installed: false,
        downloading: false,
        path: modelPath,
        error: `Incomplete installation. Missing: ${missingComponents.join(', ')}`,
        modelId,
      };
    }

    // Get actual size on disk
    let sizeBytes = 0;
    try {
      sizeBytes = await this.getDirectorySize(modelPath);
    } catch (err) {
      log.warn({ err }, 'Failed to calculate model size');
    }

    return {
      installed: true,
      downloading: false,
      sizeBytes,
      path: modelPath,
      modelId,
    };
  }

  /**
   * Get the list of required files for a given model/platform combination.
   */
  private getRequiredFiles(modelId: string): string[] {
    if (modelId === 'moonshine-base') {
      return REQUIRED_FILES_MOONSHINE;
    }
    // Parakeet
    if (process.platform === 'darwin') {
      return REQUIRED_WEIGHT_FILES_DARWIN;
    }
    return REQUIRED_FILES_WIN32;
  }

  /**
   * Start downloading the model using staging directory pattern
   * @param mainWindow Electron window for progress IPC
   * @param modelId Model to download (defaults to 'parakeet-v3')
   */
  async startDownload(mainWindow: BrowserWindow | null, modelId: string = 'parakeet-v3'): Promise<{ started: boolean; error?: string }> {
    const config = this.getModelConfig(modelId);

    if (!config) {
      return { started: false, error: `Local STT model '${modelId}' not supported on ${process.platform}` };
    }

    const downloadState = this.getDownloadState(modelId);

    if (downloadState.inProgress) {
      // If the previous download was cancelled but hasn't finalized yet, allow a new one
      if (downloadState.abortController?.signal.aborted) {
        await sleep(100);
        // Re-check after giving the cancelled download time to finalize
        if (downloadState.inProgress) {
          return { started: false, error: 'Download already in progress' };
        }
      } else {
        return { started: false, error: 'Download already in progress' };
      }
    }

    // Set inProgress synchronously to prevent concurrent startDownload() calls
    downloadState.inProgress = true;

    const modelPath = this.getModelPath(modelId);
    const stagingPath = this.getStagingPath(modelId);

    try {
      // Clean up any existing partial/failed downloads
      await this.cleanupFailedDownload(modelId);
      // Create staging directory
      fs.mkdirSync(stagingPath, { recursive: true });
    } catch (err) {
      downloadState.inProgress = false;
      throw err;
    }

    // Generate unique download ID to track this download session
    const downloadId = this.nextDownloadId++;

    // Initialize download state (inProgress already set above)
    const newState: DownloadState = {
      inProgress: true,
      abortController: new AbortController(),
      downloadedBytes: 0,
      totalBytes: config.totalSizeBytes,
      currentFile: '',
      downloadId,
    };
    this.downloadStates.set(modelId, newState);

    // Send initial progress
    this.sendProgress(mainWindow, modelId, {
      progress: 0,
      downloadedBytes: 0,
      totalBytes: config.totalSizeBytes,
      status: 'downloading',
    });

    // Start actual download in background
    this.downloadAllFiles(mainWindow, config, stagingPath, modelId)
      .then(async () => {
        const currentState = this.getDownloadState(modelId);
        // Check if this download session is still active (not cancelled and replaced)
        if (currentState.downloadId !== downloadId) {
          log.debug({ downloadId, modelId }, 'Download completed but session was replaced, skipping finalization');
          return;
        }

        // Verify all files before finalizing
        const verified = await this.verifyStagingDirectory(stagingPath, config);
        if (!verified) {
          throw new Error('Download verification failed - some files are missing or corrupted');
        }

        // Atomic swap: remove any existing model dir and rename staging to final
        if (fs.existsSync(modelPath)) {
          fs.rmSync(modelPath, { recursive: true, force: true });
        }
        fs.renameSync(stagingPath, modelPath);

        log.info({ modelPath, modelId }, 'Model download completed successfully');
        this.sendProgress(mainWindow, modelId, {
          progress: 100,
          downloadedBytes: config.totalSizeBytes,
          totalBytes: config.totalSizeBytes,
          status: 'complete',
        });
      })
      .catch(async (err) => {
        const currentState = this.getDownloadState(modelId);
        // Check if this download session is still active
        if (currentState.downloadId !== downloadId) {
          log.debug({ downloadId, modelId, error: err.message }, 'Download failed but session was replaced, skipping error handling');
          return;
        }

        if (err.name === 'AbortError') {
          log.info({ modelId }, 'Model download cancelled by user');
        } else {
          log.error({ err: err.message, modelId }, 'Model download failed');
          getErrorReporter().captureException(err, {
            tags: { area: 'local-stt', component: 'model-download' },
            extra: { platform: process.platform, modelId: config.id },
          });
          this.sendProgress(mainWindow, modelId, {
            progress: 0,
            downloadedBytes: 0,
            totalBytes: config.totalSizeBytes,
            status: 'error',
            error: this.friendlyError(err.message),
          });
        }
        // Clean up staging directory on failure
        await this.cleanupFailedDownload(modelId);
      })
      .finally(() => {
        const currentState = this.getDownloadState(modelId);
        // Only reset state if this is still the active download
        if (currentState.downloadId === downloadId) {
          currentState.inProgress = false;
          currentState.abortController = null;
        }
      });

    return { started: true };
  }

  /**
   * Cancel an in-progress download
   *
   * Note: We only abort the controller here. The download's .finally() block
   * will handle resetting inProgress once the async chain completes. This
   * prevents race conditions if startDownload is called immediately after cancel.
   * @param mainWindow Electron window for progress IPC
   * @param modelId Model to cancel (defaults to 'parakeet-v3')
   */
  cancelDownload(mainWindow: BrowserWindow | null, modelId: string = 'parakeet-v3'): void {
    const downloadState = this.getDownloadState(modelId);
    const abortController = downloadState.abortController;
    const totalBytes = downloadState.totalBytes;

    if (abortController) {
      abortController.abort();
    }

    // Send cancelled status
    if (mainWindow && !mainWindow.isDestroyed()) {
      this.sendProgress(mainWindow, modelId, {
        progress: 0,
        downloadedBytes: 0,
        totalBytes,
        status: 'cancelled',
      });
    }

    // Note: Don't reset downloadState here - let the .finally() block in startDownload
    // handle it to avoid race conditions. The abort signal will cause the download
    // to fail with AbortError, which triggers cleanup.
  }

  /**
   * Remove the downloaded model (only removes from our app's location)
   * @param modelId Model to remove (defaults to 'parakeet-v3')
   */
  async removeModel(modelId: string = 'parakeet-v3'): Promise<{ success: boolean; error?: string }> {
    const downloadState = this.getDownloadState(modelId);
    if (downloadState.inProgress) {
      return { success: false, error: 'Cannot remove model while download is in progress' };
    }

    const modelPath = this.getModelPath(modelId);

    // Safety check: only delete from our managed roots (userData/models or
    // FluidAudio/Models). Guards against accidental catastrophic rmSync on a
    // user-chosen or symlinked path.
    if (!this.isSafeManagedPath(modelPath)) {
      log.error({ modelPath }, 'Refusing to delete model outside managed roots');
      return { success: false, error: 'Cannot delete model from external location' };
    }

    // Also clean up any staging directory
    await this.cleanupFailedDownload(modelId);

    if (!fs.existsSync(modelPath)) {
      return { success: true }; // Already removed
    }

    try {
      fs.rmSync(modelPath, { recursive: true, force: true });
      log.info({ modelPath, modelId }, 'Model removed successfully');
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, modelPath, modelId }, 'Failed to remove model');
      return { success: false, error: message };
    }
  }

  /**
   * Clean up any stale staging directory left from a crashed download.
   * Synchronous and safe to call unconditionally on every startup.
   * Cleans staging directories for all known models.
   */
  cleanupStaleStaging(): void {
    // Clean staging for all known model IDs on this platform
    const platform = process.platform;
    for (const [key, config] of Object.entries(MODELS)) {
      if (!key.startsWith(`${platform}:`)) continue;
      const modelId = config.id;
      const downloadState = this.getDownloadState(modelId);
      if (downloadState.inProgress) continue;

      const stagingPath = this.getStagingPath(modelId);

      // Safety: only clean within our managed roots
      if (!this.isSafeManagedPath(stagingPath)) {
        log.error({ stagingPath }, 'Refusing to clean staging directory outside managed roots');
        continue;
      }

      if (fs.existsSync(stagingPath)) {
        fs.rmSync(stagingPath, { recursive: true, force: true });
        log.info({ stagingPath, modelId }, 'Removed stale staging directory from previous crash');
      }
    }
  }

  /**
   * Download all model files with retry logic
   */
  private async downloadAllFiles(
    mainWindow: BrowserWindow | null,
    config: ModelConfig,
    destPath: string,
    modelId: string = 'parakeet-v3'
  ): Promise<void> {
    const filesToDownload = config.files.filter(f => !f.isDirectory);
    let downloadedSoFar = 0;
    const downloadState = this.getDownloadState(modelId);

    for (const file of filesToDownload) {
      // Check for cancellation
      if (downloadState.abortController?.signal.aborted) {
        throw new DOMException('Download cancelled', 'AbortError');
      }

      downloadState.currentFile = file.path;
      const destFilePath = path.join(destPath, file.path);

      // Ensure parent directory exists
      const parentDir = path.dirname(destFilePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Download with retry
      const url = `${HF_BASE_URL}/${config.hfRepo}/resolve/main/${file.hfPath}?download=true`;
      const fileSize = await this.downloadFileWithRetry(
        url,
        destFilePath,
        file.sha256,
        file.sizeBytes,
        modelId,
        (chunkBytes) => {
          downloadedSoFar += chunkBytes;
          downloadState.downloadedBytes = downloadedSoFar;

          const progress = Math.round((downloadedSoFar / config.totalSizeBytes) * 100);
          this.sendProgress(mainWindow, modelId, {
            progress: Math.min(progress, 99), // Reserve 100 for complete
            downloadedBytes: downloadedSoFar,
            totalBytes: config.totalSizeBytes,
            status: 'downloading',
          });
        }
      );

      log.debug({ file: file.path, size: fileSize, modelId }, 'Downloaded file');
    }
  }

  /**
   * Download a file with retry logic and exponential backoff
   */
  private async downloadFileWithRetry(
    url: string,
    destPath: string,
    expectedSha256?: string,
    expectedSize?: number,
    modelId: string = 'parakeet-v3',
    onProgress?: (bytes: number) => void
  ): Promise<number> {
    let lastError: Error | null = null;
    const downloadState = this.getDownloadState(modelId);

    for (let attempt = 0; attempt < DOWNLOAD_CONFIG.maxRetries; attempt++) {
      // Check for cancellation before each attempt
      if (downloadState.abortController?.signal.aborted) {
        throw new DOMException('Download cancelled', 'AbortError');
      }

      let bytesThisAttempt = 0;
      try {
        const result = await this.downloadFile(url, destPath, expectedSha256, expectedSize, (chunk) => {
          bytesThisAttempt += chunk;
          onProgress?.(chunk);
        }, 5, modelId);
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Subtract bytes from failed attempt so progress doesn't inflate
        if (bytesThisAttempt > 0 && onProgress) {
          onProgress(-bytesThisAttempt);
        }

        // Don't retry on cancellation or checksum errors
        if (lastError.name === 'AbortError' || lastError.message?.includes('Checksum mismatch')) {
          throw lastError;
        }

        // Don't retry on local filesystem errors (not recoverable by retrying)
        if (/ENOSPC|EACCES|EPERM/.test(lastError.message)) {
          throw lastError;
        }

        // Don't retry on most HTTP 4xx errors (client errors, typically not recoverable)
        // Exception: 408 (Request Timeout) and 429 (Too Many Requests) are retryable
        const httpErrorMatch = lastError.message?.match(/HTTP (\d{3})/);
        if (httpErrorMatch) {
          const statusCode = parseInt(httpErrorMatch[1], 10);
          if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
            throw lastError;
          }
        }

        if (attempt < DOWNLOAD_CONFIG.maxRetries - 1) {
          const delay = calculateRetryDelay(attempt);
          log.warn(
            { file: path.basename(destPath), attempt: attempt + 1, delay, error: lastError.message },
            'Download failed, retrying'
          );
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error(`Failed to download ${path.basename(destPath)} after ${DOWNLOAD_CONFIG.maxRetries} attempts`);
  }

  /**
   * Download a single file with progress callback.
   * Supports HTTP Range resume: if a partial temp file exists, sends a Range header
   * to resume from where it left off. Falls back to a fresh download if the server
   * doesn't support Range requests (returns 200 instead of 206).
   * In-flight hash is skipped during resume — integrity is verified by verifyStagingDirectory().
   */
  private downloadFile(
    url: string,
    destPath: string,
    expectedSha256?: string,
    expectedSize?: number,
    onProgress?: (bytes: number) => void,
    maxRedirects = 5,
    modelId: string = 'parakeet-v3'
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const tempPath = `${destPath}.downloading`;
      const timeout = calculateTimeout(expectedSize);

      // Check for existing partial file to enable Range resume
      let existingBytes = 0;
      if (fs.existsSync(tempPath)) {
        try {
          existingBytes = fs.statSync(tempPath).size;
        } catch {
          existingBytes = 0;
        }
      }

      // Use http or https based on URL protocol
      const httpModule = url.startsWith('http://') ? http : https;

      // Build request options with optional Range header
      const requestUrl = new URL(url);
      const requestOptions: https.RequestOptions = {
        hostname: requestUrl.hostname,
        path: requestUrl.pathname + requestUrl.search,
        timeout,
        headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : undefined,
      };

      const request = httpModule.get(requestOptions, (response) => {
        // Handle redirects (HuggingFace uses them for LFS)
        // Include 303 for completeness in redirect chain handling
        const isRedirect = response.statusCode === 301 || response.statusCode === 302 ||
                          response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308;

        if (isRedirect) {
          // Drain the response to free the socket
          response.resume();

          if (maxRedirects <= 0) {
            reject(new Error(`Too many redirects downloading ${destPath}`));
            return;
          }
          const location = response.headers.location;
          if (location) {
            let redirectUrl: string;
            if (location.startsWith('https://')) {
              redirectUrl = location;
            } else if (!location.startsWith('http')) {
              // Relative URL — resolve against current origin
              const currentUrl = new URL(url);
              redirectUrl = new URL(location, currentUrl.origin).href;
            } else {
              // Reject HTTP downgrade (http:// or other schemes)
              reject(new Error('Refusing insecure HTTP redirect'));
              return;
            }
            this.downloadFile(redirectUrl, destPath, expectedSha256, expectedSize, onProgress, maxRedirects - 1, modelId)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        // Determine if we're resuming or starting fresh
        const isResume = response.statusCode === 206 && existingBytes > 0;

        if (response.statusCode === 200 && existingBytes > 0) {
          // Server doesn't support Range — delete partial and start fresh
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
          existingBytes = 0;
        }

        if (response.statusCode !== 200 && response.statusCode !== 206) {
          // Drain the response to free the socket
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }

        // Append for resume, write fresh otherwise
        const fileStream = fs.createWriteStream(tempPath, isResume ? { flags: 'a' } : undefined);
        // Skip in-flight hash during resume — verifyStagingDirectory() does full integrity check
        const hash = !isResume && expectedSha256 ? crypto.createHash('sha256') : null;
        let downloadedBytes = isResume ? existingBytes : 0;
        let streamClosed = false;

        // Report existing partial bytes as already-downloaded progress
        if (isResume && existingBytes > 0) {
          onProgress?.(existingBytes);
        }

        const cleanup = (err?: Error) => {
          if (!streamClosed) {
            streamClosed = true;
            response.destroy();
            fileStream.destroy();
            // On error, keep temp file for potential future resume (don't delete it)
            if (err) {
              reject(err);
            }
          }
        };

        // Handle response errors
        response.on('error', (err) => {
          cleanup(new Error(`Response error: ${err.message}`));
        });

        response.on('aborted', () => {
          cleanup(new Error('Response aborted'));
        });

        response.on('data', (chunk: Buffer) => {
          // Check for cancellation
          if (this.getDownloadState(modelId).abortController?.signal.aborted) {
            cleanup(new DOMException('Download cancelled', 'AbortError'));
            return;
          }

          downloadedBytes += chunk.length;
          hash?.update(chunk);
          onProgress?.(chunk.length);
        });

        response.pipe(fileStream);

        fileStream.on('error', (err) => {
          cleanup(new Error(`File write error: ${err.message}`));
        });

        fileStream.on('close', () => {
          if (streamClosed) return; // Already handled error
          streamClosed = true;

          // Verify in-flight checksum if available (fresh downloads only)
          if (hash && expectedSha256) {
            const actualHash = hash.digest('hex');
            if (actualHash !== expectedSha256) {
              try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
              reject(new Error(`Checksum mismatch for ${path.basename(destPath)}`));
              return;
            }
          }

          // Rename temp file to final name
          try {
            fs.renameSync(tempPath, destPath);
            resolve(downloadedBytes);
          } catch (err: unknown) {
            reject(new Error(`Failed to finalize download: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      });

      request.on('error', (err) => {
        reject(new Error(`Network error: ${err.message}`));
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`Download timeout after ${timeout}ms`));
      });
    });
  }

  /**
   * Verify all required files exist in staging directory
   */
  private async verifyStagingDirectory(stagingPath: string, config: ModelConfig): Promise<boolean> {
    const filesToVerify = config.files.filter(f => !f.isDirectory);

    for (const file of filesToVerify) {
      const filePath = path.join(stagingPath, file.path);
      if (!fs.existsSync(filePath)) {
        log.error({ file: file.path }, 'Missing file in staging directory');
        return false;
      }

      // Verify file is non-empty (sizeBytes is used for progress/timeouts, not strict verification)
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        log.error({ file: file.path }, 'Downloaded file is empty');
        return false;
      }

      // Verify checksum if provided (streaming to avoid blocking main process)
      const hash = crypto.createHash('sha256');
      const actualHash = await new Promise<string>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => { stream.destroy(); reject(err); });
      });
      if (file.sha256) {
        if (actualHash !== file.sha256) {
          log.error({ file: file.path }, 'Checksum mismatch in staging verification');
          return false;
        }
      } else {
        // Log computed hash for files without pinned checksums (for future pinning)
        log.info({ file: file.path, sha256: actualHash }, 'Computed hash for unpinned file — pin this value to enable integrity verification');
      }
    }

    return true;
  }

  /**
   * Clean up failed download - removes staging directory and any partial model directory
   */
  private async cleanupFailedDownload(modelId: string = 'parakeet-v3'): Promise<void> {
    const stagingPath = this.getStagingPath(modelId);
    const modelPath = this.getModelPath(modelId);

    // Safety check: only clean within our managed roots
    if (!this.isSafeManagedPath(stagingPath) || !this.isSafeManagedPath(modelPath)) {
      log.error({ stagingPath, modelPath }, 'Refusing to clean up directories outside managed roots');
      return;
    }

    try {
      // Remove staging directory
      if (fs.existsSync(stagingPath)) {
        fs.rmSync(stagingPath, { recursive: true, force: true });
        log.debug({ stagingPath }, 'Removed staging directory');
      }

      // If the model directory exists but is incomplete, remove it too
      if (fs.existsSync(modelPath)) {
        const requiredFiles = this.getRequiredFiles(modelId);
        const isComplete = requiredFiles.every(f => {
          const filePath = path.join(modelPath, f);
          return fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory();
        });
        if (!isComplete) {
          fs.rmSync(modelPath, { recursive: true, force: true });
          log.debug({ modelPath }, 'Removed incomplete model directory');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Error cleaning up failed download');
    }
  }

  /**
   * Map raw Node.js/network error messages to user-friendly descriptions.
   * Raw errors are kept in logs; only the friendly version is sent to the renderer.
   */
  private friendlyError(raw: string): string {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(raw)) {
      return 'Could not reach the download server. Check your internet connection and try again.';
    }
    if (/ETIMEDOUT|ECONNRESET|socket hang up|timeout/i.test(raw)) {
      return 'The download was interrupted. Your connection may be unstable — try again.';
    }
    if (/ENOSPC/.test(raw)) {
      return 'Not enough disk space to download the voice model.';
    }
    if (/EACCES|EPERM/.test(raw)) {
      return 'Permission denied. Try restarting the app.';
    }
    if (/HTTP [45]\d\d/.test(raw)) {
      return 'The download server returned an error. Please try again later.';
    }
    if (/Checksum mismatch/.test(raw)) {
      return 'The downloaded file was corrupted. Please try again.';
    }
    return 'Download failed. Please try again.';
  }

  /**
   * Flush any pending throttled progress event before sending terminal states.
   */
  private flushPendingProgress(modelId: string): void {
    const pending = this.pendingProgressMap.get(modelId);
    if (pending) {
      const { mainWindow, progress } = pending;
      this.pendingProgressMap.delete(modelId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('local-stt:model-download-progress', progress);
      }
    }
  }

  /**
   * Send download progress to renderer.
   * Throttled to at most once per 250ms for non-terminal states to avoid
   * flooding the IPC channel (~3000 events/sec at full download speed).
   * Terminal states (complete, error, cancelled) are always sent immediately.
   * Progress events include modelId so the UI can filter per model.
   */
  private sendProgress(
    mainWindow: BrowserWindow | null,
    modelId: string,
    progress: {
      progress: number;
      downloadedBytes: number;
      totalBytes: number;
      status: 'downloading' | 'extracting' | 'complete' | 'error' | 'cancelled';
      error?: string;
    }
  ): void {
    const payload = { ...progress, modelId };

    // Always send terminal states immediately (with flush to avoid stale progress)
    if (progress.status !== 'downloading' && progress.status !== 'extracting') {
      this.flushPendingProgress(modelId);
      this.lastProgressSendTimes.set(modelId, Date.now());
      this.pendingProgressMap.delete(modelId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('local-stt:model-download-progress', payload);
      }
      return;
    }

    const now = Date.now();
    const lastSendTime = this.lastProgressSendTimes.get(modelId) ?? 0;
    if (now - lastSendTime >= 250) {
      this.lastProgressSendTimes.set(modelId, now);
      this.pendingProgressMap.delete(modelId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('local-stt:model-download-progress', payload);
      }
    } else {
      this.pendingProgressMap.set(modelId, { mainWindow, progress: payload });
    }
  }

  /**
   * Calculate total size of a directory
   */
  // bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await this.getDirectorySize(entryPath);
      } else {
        totalSize += fs.statSync(entryPath).size;
      }
    }

    return totalSize;
  }
}

// Singleton instance
export const localSttModelManager = new LocalSttModelManager();

// Export for testing
export { LocalSttModelManager, DOWNLOAD_CONFIG, calculateTimeout, calculateRetryDelay };
