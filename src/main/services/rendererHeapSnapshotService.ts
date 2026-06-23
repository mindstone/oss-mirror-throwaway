import { app, BrowserWindow, type ProcessMetric } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'rendererHeapSnapshot' });

const MAX_SNAPSHOT_PAIRS = 4;
const UNKNOWN_RENDERER_WORKING_SET_FLOOR_BYTES = 1024 * 1024 * 1024;

let getMainWindowFn: (() => BrowserWindow | null) | null = null;

export type RendererHeapSnapshotTrigger = 'manual' | 'watchdog';

export interface RendererHeapSnapshotCaptureRequest {
  trigger: RendererHeapSnapshotTrigger;
  label?: string;
}

export interface RendererHeapSnapshotMeta {
  timestamp: string;
  appVersion: string;
  label?: string;
  trigger: RendererHeapSnapshotTrigger;
  rendererWorkingSetMB?: number;
  snapshotFileBytes: number;
  durationMs: number;
}

export type RendererHeapSnapshotResult =
  | {
    status: 'captured';
    path: string;
    metaPath: string;
    rendererWorkingSetMB?: number;
    snapshotFileBytes: number;
    durationMs: number;
  }
  | {
    status: 'skipped_no_window';
    error: string;
  }
  | {
    status: 'skipped_low_disk';
    error: string;
    freeBytes: number;
    requiredFreeBytes: number;
    rendererWorkingSetMB?: number;
  }
  | {
    status: 'failed';
    error: string;
  };

function getSnapshotDir(): string {
  return path.join(getDataPath(), 'heap-snapshots');
}

function getMainWindow(): BrowserWindow | null {
  const injectedWindow = getMainWindowFn?.();
  if (injectedWindow) {
    return injectedWindow;
  }
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: heap snapshot capture uses injected main-window getter first; fallback keeps the dev-only IPC helper usable before a dedicated ensure-main-window capability exists.
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null;
}

function sanitizeLabel(label: string): string {
  return label
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildSnapshotPath(timestamp: string, label?: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  const safeLabel = label ? sanitizeLabel(label) : '';
  const suffix = safeLabel ? `-${safeLabel}` : '';
  return path.join(getSnapshotDir(), `renderer-heap-${safeTimestamp}${suffix}.heapsnapshot`);
}

function getRendererMetric(mainWindow: BrowserWindow): ProcessMetric | undefined {
  const rendererPid = mainWindow.webContents.getOSProcessId();
  return app.getAppMetrics().find((metric) => metric.pid === rendererPid);
}

function getRendererWorkingSetBytes(metric: ProcessMetric | undefined): number {
  if (!metric) {
    return UNKNOWN_RENDERER_WORKING_SET_FLOOR_BYTES;
  }
  return metric.memory.workingSetSize * 1024;
}

async function getAvailableBytes(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return stats.bavail * stats.bsize;
}

async function rotateOldSnapshots(): Promise<void> {
  const dir = getSnapshotDir();
  try {
    const files = await fs.readdir(dir);
    const snapshots = files
      .filter((file) => file.endsWith('.heapsnapshot'))
      .sort();

    if (snapshots.length <= MAX_SNAPSHOT_PAIRS) {
      return;
    }

    const toDelete = snapshots.slice(0, snapshots.length - MAX_SNAPSHOT_PAIRS);
    for (const file of toDelete) {
      const snapshotPath = path.join(dir, file);
      await fs.unlink(snapshotPath).catch((err: unknown) => {
        ignoreBestEffortCleanup(err, {
          operation: 'rendererHeapSnapshot.rotate.unlinkSnapshot',
          reason: 'Snapshot rotation should continue when an already-selected old file disappears.',
        });
      });
      await fs.unlink(`${snapshotPath}.meta.json`).catch((err: unknown) => {
        ignoreBestEffortCleanup(err, {
          operation: 'rendererHeapSnapshot.rotate.unlinkSidecar',
          reason: 'Snapshot rotation should continue when an old sidecar is already absent.',
        });
      });
    }

    log.debug(
      {
        deletedPairs: toDelete.length,
        maxSnapshotPairs: MAX_SNAPSHOT_PAIRS,
      },
      'Rotated old renderer heap snapshots',
    );
  } catch (err) {
    log.warn({ err }, 'Failed to rotate renderer heap snapshots');
  }
}

export function initRendererHeapSnapshotService(getMainWindow: () => BrowserWindow | null): void {
  getMainWindowFn = getMainWindow;
  log.info(
    {
      snapshotDir: getSnapshotDir(),
      maxSnapshotPairs: MAX_SNAPSHOT_PAIRS,
    },
    'Renderer heap snapshot service initialized',
  );
}

export async function captureRendererHeapSnapshot(
  request: RendererHeapSnapshotCaptureRequest,
): Promise<RendererHeapSnapshotResult> {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    const result: RendererHeapSnapshotResult = {
      status: 'skipped_no_window',
      error: 'No renderer window is available for heap snapshot capture.',
    };
    log.warn({ trigger: request.trigger, label: request.label }, 'Renderer heap snapshot skipped: no window');
    return result;
  }

  const snapshotDir = getSnapshotDir();
  try {
    await fs.mkdir(snapshotDir, { recursive: true });

    const rendererMetric = getRendererMetric(mainWindow);
    const rendererWorkingSetBytes = getRendererWorkingSetBytes(rendererMetric);
    const rendererWorkingSetMB = rendererMetric
      ? Math.round(rendererMetric.memory.workingSetSize / 1024)
      : undefined;
    const freeBytes = await getAvailableBytes(snapshotDir);
    const requiredFreeBytes = rendererWorkingSetBytes * 2;

    if (freeBytes < requiredFreeBytes) {
      const result: RendererHeapSnapshotResult = {
        status: 'skipped_low_disk',
        error: 'Not enough free disk space for renderer heap snapshot capture.',
        freeBytes,
        requiredFreeBytes,
        rendererWorkingSetMB,
      };
      log.warn(
        {
          trigger: request.trigger,
          label: request.label,
          freeBytes,
          requiredFreeBytes,
          rendererWorkingSetMB,
        },
        'Renderer heap snapshot skipped: low disk',
      );
      return result;
    }

    if (!rendererMetric) {
      log.warn(
        {
          trigger: request.trigger,
          label: request.label,
          requiredFreeBytes,
        },
        'Renderer heap snapshot proceeding with conservative disk guard because renderer metric was unavailable',
      );
    }

    const timestamp = new Date().toISOString();
    const snapshotPath = buildSnapshotPath(timestamp, request.label);
    const metaPath = `${snapshotPath}.meta.json`;

    const startedAt = performance.now();
    await mainWindow.webContents.takeHeapSnapshot(snapshotPath);
    const durationMs = Math.round(performance.now() - startedAt);

    const snapshotStats = await fs.stat(snapshotPath);
    const meta: RendererHeapSnapshotMeta = {
      timestamp,
      appVersion: app.getVersion(),
      label: request.label,
      trigger: request.trigger,
      rendererWorkingSetMB,
      snapshotFileBytes: snapshotStats.size,
      durationMs,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    await rotateOldSnapshots();

    const result: RendererHeapSnapshotResult = {
      status: 'captured',
      path: snapshotPath,
      metaPath,
      rendererWorkingSetMB,
      snapshotFileBytes: snapshotStats.size,
      durationMs,
    };

    log.info(
      {
        trigger: request.trigger,
        label: request.label,
        snapshotFile: path.basename(snapshotPath),
        metaFile: path.basename(metaPath),
        rendererWorkingSetMB,
        snapshotFileBytes: snapshotStats.size,
        durationMs,
      },
      'Renderer heap snapshot captured',
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err, trigger: request.trigger, label: request.label }, 'Renderer heap snapshot capture failed');
    return { status: 'failed', error };
  }
}

export function stopRendererHeapSnapshotService(): void {
  getMainWindowFn = null;
  log.info('Renderer heap snapshot service stopped');
}

export function _resetRendererHeapSnapshotServiceForTesting(): void {
  getMainWindowFn = null;
}
