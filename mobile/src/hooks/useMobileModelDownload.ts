/**
 * @device-scoped: Moonshine model files and download resume state are local device assets.
 *
 * Hook for managing Moonshine model download lifecycle on mobile.
 *
 * Uses expo-file-system for native downloads with resume support.
 * Follows hardened download patterns from desktop (staging, progress throttle,
 * space check, cellular warning, friendly errors).
 *
 * Model freshness: after downloading, a manifest.json is written alongside
 * the model files recording each file's actual byte size. On mount the hook
 * fires a lightweight HEAD request against the first model file to detect
 * upstream size changes and surfaces an `update-available` status so the UI
 * can offer the user a one-tap update.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Paths, Directory, File as ExpoFile } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Versioned directory name — bump the suffix when shipping a new model version */
const MODEL_DIR = 'models/moonshine-medium-streaming-en-v1';
const STAGING_DIR = '.staging/moonshine-medium-streaming-en-v1';
const STATE_KEY = 'rebel:moonshine-download-state';
const MANIFEST_NAME = 'manifest.json';

/** Minimum free disk space required to start download (500MB buffer over model size) */
const MIN_FREE_SPACE_BYTES = 900 * 1024 * 1024;

/** Model files to download — sizes are estimates for progress display only.
 *  Validation uses the server's Content-Length header, not these values,
 *  so upstream model updates won't cause spurious failures. */
const MODEL_FILES = [
  { name: 'encoder.ort', sizeBytes: 94_202_872 },
  { name: 'decoder_kv.ort', sizeBytes: 146_216_448 },
  { name: 'frontend.ort', sizeBytes: 47_467_256 },
  { name: 'adapter.ort', sizeBytes: 3_647_712 },
  { name: 'cross_kv.ort', sizeBytes: 11_544_952 },
  { name: 'decoder_kv_with_attention.ort', sizeBytes: 146_138_304 },
  { name: 'streaming_config.json', sizeBytes: 513 },
  { name: 'tokenizer.bin', sizeBytes: 249_974 },
] as const;

const TOTAL_SIZE_BYTES = MODEL_FILES.reduce((sum, f) => sum + f.sizeBytes, 0);
const TOTAL_SIZE_DISPLAY = '~410 MB';
const DOWNLOAD_BASE_URL = 'https://download.moonshine.ai/model/medium-streaming-en/quantized/';

/** Throttle progress updates to ~250ms */
const PROGRESS_THROTTLE_MS = 250;

/** How often to check for upstream model updates (24 hours) */
const FRESHNESS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FRESHNESS_CHECK_KEY = 'rebel:moonshine-last-freshness-check';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelDownloadStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'downloaded'
  | 'update-available'
  | 'error';

interface PersistedDownloadState {
  /** Index of the file currently being downloaded (for resume) */
  currentFileIndex: number;
  /** Bytes downloaded so far across all completed files */
  completedBytes: number;
}

interface ModelManifest {
  /** Timestamp when the model was downloaded */
  downloadedAt: string;
  /** Per-file actual sizes from the download */
  files: Record<string, number>;
}

export interface MobileModelDownloadState {
  status: ModelDownloadStatus;
  /** Download progress 0-1 */
  progress: number;
  /** Bytes downloaded */
  downloadedBytes: number;
  /** Total bytes to download */
  totalBytes: number;
  /** Whether device is on cellular network */
  isCellular: boolean;
  /** Friendly error message if status is 'error' */
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Exported utilities (used by voice recording hook for routing decisions)
// ---------------------------------------------------------------------------

/**
 * Get the model directory path (without trailing slash).
 * Used to pass to the native module's loadModel().
 */
export function getModelDirectoryPath(): string {
  return new Directory(Paths.document, MODEL_DIR).uri;
}

/**
 * Check if the Moonshine model is fully downloaded and ready to use.
 * Verifies all model files exist in the expected directory.
 */
export async function isMoonshineModelReady(): Promise<boolean> {
  try {
    const modelDir = new Directory(Paths.document, MODEL_DIR);
    if (!modelDir.exists) return false;

    for (const file of MODEL_FILES) {
      const f = new ExpoFile(modelDir, file.name);
      if (!f.exists || f.size === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Purge downloaded model files from disk.
 * Call when the native module fails to load the model (corrupt/stale files).
 * This forces the download hook to show 'not-downloaded' status, prompting
 * the user (or auto-recovery logic) to re-download.
 */
export async function purgeModelFiles(): Promise<void> {
  try {
    const modelDir = new Directory(Paths.document, MODEL_DIR);
    if (modelDir.exists) modelDir.delete();
    const stagingDir = new Directory(Paths.document, STAGING_DIR);
    if (stagingDir.exists) stagingDir.delete();
    await AsyncStorage.removeItem(STATE_KEY);
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModelDirectory(): Directory {
  return new Directory(Paths.document, MODEL_DIR);
}

function getStagingDirectory(): Directory {
  return new Directory(Paths.document, STAGING_DIR);
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('network') || message.includes('Network') || message.includes('ENETUNREACH')) {
    return 'Network error — check your connection and try again.';
  }
  if (message.includes('space') || message.includes('ENOSPC') || message.includes('disk')) {
    return 'Not enough storage space. Free up some space and try again.';
  }
  if (message.includes('cancel') || message.includes('Cancel')) {
    return 'Download cancelled.';
  }
  return `Download failed: ${message.slice(0, 100)}`;
}

/** Read the manifest written after a successful download. */
async function readManifest(): Promise<ModelManifest | null> {
  try {
    const manifestFile = new ExpoFile(getModelDirectory(), MANIFEST_NAME);
    if (!manifestFile.exists) return null;
    const text = await manifestFile.text();
    return JSON.parse(text) as ModelManifest;
  } catch {
    return null;
  }
}

/** Write manifest after a successful download. */
function writeManifest(files: Record<string, number>): void {
  const manifest: ModelManifest = {
    downloadedAt: new Date().toISOString(),
    files,
  };
  const manifestFile = new ExpoFile(getModelDirectory(), MANIFEST_NAME);
  manifestFile.create();
  manifestFile.write(JSON.stringify(manifest));
}

/**
 * Lightweight freshness check: HEAD request on the first model file and
 * compare Content-Length against the manifest. Returns true if an update
 * is available (sizes differ).
 */
async function checkForModelUpdate(): Promise<boolean> {
  const manifest = await readManifest();
  if (!manifest) return false;

  const probeFile = MODEL_FILES[0];
  const manifestSize = manifest.files[probeFile.name];
  if (!manifestSize) return false;

  try {
    const resp = await fetch(`${DOWNLOAD_BASE_URL}${probeFile.name}`, { method: 'HEAD' });
    const serverLength = resp.headers.get('content-length');
    if (!serverLength) return false;

    return Number(serverLength) !== manifestSize;
  } catch {
    return false;
  }
}

/** Throttle freshness checks to once per FRESHNESS_CHECK_INTERVAL_MS. */
async function shouldRunFreshnessCheck(): Promise<boolean> {
  try {
    const lastCheck = await AsyncStorage.getItem(FRESHNESS_CHECK_KEY);
    if (!lastCheck) return true;
    return Date.now() - Number(lastCheck) > FRESHNESS_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

async function recordFreshnessCheck(): Promise<void> {
  await AsyncStorage.setItem(FRESHNESS_CHECK_KEY, String(Date.now()));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMobileModelDownload(): MobileModelDownloadState & {
  startDownload: () => Promise<void>;
  cancelDownload: () => void;
  removeModel: () => Promise<void>;
  checkModelStatus: () => Promise<void>;
  totalSizeDisplay: string;
  modelName: string;
} {
  const [status, setStatus] = useState<ModelDownloadStatus>('not-downloaded');
  const [progress, setProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [isCellular, setIsCellular] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const downloadResumableRef = useRef<LegacyFS.DownloadResumable | null>(null);
  const cancelledRef = useRef(false);
  const lastProgressUpdateRef = useRef(0);

  // Check network type on mount
  useEffect(() => {
    NetInfo.fetch().then((state) => {
      setIsCellular(state.type === 'cellular');
    });
  }, []);

  // Check model status on mount
  const checkModelStatus = useCallback(async () => {
    try {
      const modelDir = getModelDirectory();
      if (!modelDir.exists) {
        setStatus('not-downloaded');
        return;
      }

      // Check all model files exist and are non-empty
      let allFilesPresent = true;
      for (const file of MODEL_FILES) {
        const f = new ExpoFile(modelDir, file.name);
        if (!f.exists || f.size === 0) {
          allFilesPresent = false;
          break;
        }
      }

      if (!allFilesPresent) {
        setStatus('not-downloaded');
        return;
      }

      // Model is locally valid — check for upstream updates (throttled)
      setStatus('downloaded');

      if (await shouldRunFreshnessCheck()) {
        const updateAvailable = await checkForModelUpdate();
        await recordFreshnessCheck();
        if (updateAvailable) {
          setStatus('update-available');
        }
      }
    } catch {
      setStatus('not-downloaded');
    }
  }, []);

  useEffect(() => {
    void checkModelStatus();
  }, [checkModelStatus]);

  const startDownload = useCallback(async () => {
    cancelledRef.current = false;
    setErrorMessage(null);

    try {
      const freeSpace = Paths.availableDiskSpace;
      if (freeSpace < MIN_FREE_SPACE_BYTES) {
        setStatus('error');
        setErrorMessage(
          `Not enough storage space. Need ~${Math.ceil(MIN_FREE_SPACE_BYTES / (1024 * 1024))} MB free, ` +
          `but only ${Math.ceil(freeSpace / (1024 * 1024))} MB available.`
        );
        return;
      }

      // Check network
      const netState = await NetInfo.fetch();
      setIsCellular(netState.type === 'cellular');

      setStatus('downloading');
      setProgress(0);
      setDownloadedBytes(0);

      // Try to resume from persisted state
      let startFileIndex = 0;
      let completedBytes = 0;
      try {
        const savedState = await AsyncStorage.getItem(STATE_KEY);
        if (savedState) {
          const parsed: PersistedDownloadState = JSON.parse(savedState);
          startFileIndex = parsed.currentFileIndex;
          completedBytes = parsed.completedBytes;
        }
      } catch {
        // Ignore — start fresh
      }

      // Ensure staging directory exists
      const stagingDir = getStagingDirectory();
      stagingDir.create({ intermediates: true, idempotent: true });

      // Track actual sizes for the manifest
      const actualFileSizes: Record<string, number> = {};

      // Download each file sequentially (uses legacy API for progress callbacks)
      for (let i = startFileIndex; i < MODEL_FILES.length; i++) {
        if (cancelledRef.current) {
          setStatus('not-downloaded');
          setErrorMessage('Download cancelled.');
          return;
        }

        const file = MODEL_FILES[i];
        const fileUrl = `${DOWNLOAD_BASE_URL}${file.name}`;
        const stagingFile = new ExpoFile(stagingDir, file.name);

        // Persist progress for resume
        const persistState: PersistedDownloadState = {
          currentFileIndex: i,
          completedBytes,
        };
        await AsyncStorage.setItem(STATE_KEY, JSON.stringify(persistState));

        const fileStartBytes = completedBytes;

        const downloadResumable = LegacyFS.createDownloadResumable(
          fileUrl,
          stagingFile.uri,
          {},
          (downloadProgress) => {
            const now = Date.now();
            if (now - lastProgressUpdateRef.current < PROGRESS_THROTTLE_MS) return;
            lastProgressUpdateRef.current = now;

            const fileBytesDownloaded = downloadProgress.totalBytesWritten;
            const totalDownloaded = fileStartBytes + fileBytesDownloaded;
            setDownloadedBytes(totalDownloaded);
            setProgress(totalDownloaded / TOTAL_SIZE_BYTES);
          }
        );
        downloadResumableRef.current = downloadResumable;

        const result = await downloadResumable.downloadAsync();
        if (!result || cancelledRef.current) {
          if (cancelledRef.current) {
            setStatus('not-downloaded');
            setErrorMessage('Download cancelled.');
          }
          return;
        }

        // Verify downloaded file size against the server's Content-Length
        // (not the hardcoded estimate) so upstream model updates don't cause failures.
        const actualSize = stagingFile.size;
        const serverLength = result.headers?.['Content-Length'];
        const expectedSize = serverLength ? Number(serverLength) : 0;
        if (actualSize > 0 && expectedSize > 0 && actualSize !== expectedSize) {
          stagingFile.delete();
          throw new Error(
            `Downloaded ${file.name} has wrong size (${actualSize} vs expected ${expectedSize}). ` +
            'The download may be corrupted. Please try again.'
          );
        }

        actualFileSizes[file.name] = actualSize;
        completedBytes += actualSize || file.sizeBytes;
        setDownloadedBytes(completedBytes);
        setProgress(completedBytes / TOTAL_SIZE_BYTES);
      }

      if (cancelledRef.current) {
        setStatus('not-downloaded');
        return;
      }

      // Move from staging to final location
      const modelDir = getModelDirectory();
      modelDir.create({ intermediates: true, idempotent: true });

      for (const file of MODEL_FILES) {
        const src = new ExpoFile(stagingDir, file.name);
        const dest = new ExpoFile(modelDir, file.name);
        if (dest.exists) {
          dest.delete();
        }
        src.move(dest);
      }

      // Write manifest recording actual file sizes for freshness checks
      writeManifest(actualFileSizes);

      // Clean up staging and persisted state
      if (stagingDir.exists) stagingDir.delete();
      await AsyncStorage.removeItem(STATE_KEY);
      // Reset freshness check timer since we just downloaded fresh files
      await recordFreshnessCheck();

      setStatus('downloaded');
      setProgress(1);
    } catch (err) {
      if (cancelledRef.current) {
        setStatus('not-downloaded');
        setErrorMessage('Download cancelled.');
        return;
      }
      setStatus('error');
      setErrorMessage(friendlyError(err));
    }
  }, []);

  const cancelDownload = useCallback(() => {
    cancelledRef.current = true;
    if (downloadResumableRef.current) {
      void downloadResumableRef.current.pauseAsync();
      downloadResumableRef.current = null;
    }
    setStatus('not-downloaded');
    setProgress(0);
    setDownloadedBytes(0);
    setErrorMessage(null);
  }, []);

  const removeModel = useCallback(async () => {
    try {
      const modelDir = getModelDirectory();
      if (modelDir.exists) modelDir.delete();
      const stagingDir = getStagingDirectory();
      if (stagingDir.exists) stagingDir.delete();
      await AsyncStorage.removeItem(STATE_KEY);
      setStatus('not-downloaded');
      setProgress(0);
      setDownloadedBytes(0);
      setErrorMessage(null);
    } catch {
      // Ignore cleanup errors
    }
  }, []);

  return {
    status,
    progress,
    downloadedBytes,
    totalBytes: TOTAL_SIZE_BYTES,
    isCellular,
    errorMessage,
    startDownload,
    cancelDownload,
    removeModel,
    checkModelStatus,
    totalSizeDisplay: TOTAL_SIZE_DISPLAY,
    modelName: 'Moonshine Medium',
  };
}
