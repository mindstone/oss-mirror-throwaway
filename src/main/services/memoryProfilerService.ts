/**
 * Main Process Memory Profiler (dev:perf only)
 *
 * Captures periodic V8 heap space breakdowns and process memory metrics.
 * Complements the CPU profiler for memory-focused performance analysis.
 *
 * Output:
 * - .memory.json files in userData/memory-profiles/ (machine-readable)
 * - Structured log entries with heap space breakdown
 *
 * Gating: process.env.REBEL_PERF_MODE === '1' (set by npm run dev:perf)
 * Zero production cost — never loaded outside dev:perf.
 *
 * Usage:
 *   npm run dev:perf   # captures memory snapshots automatically
 *
 * View summaries:
 *   cat ~/Library/Application\ Support/mindstone-rebel/memory-profiles/*.memory.json
 */

import * as v8 from 'node:v8';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'memoryProfiler' });

const PROFILE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const MAX_PROFILE_FILES = 20; // rotate old profiles to avoid filling disk

let intervalTimer: ReturnType<typeof setTimeout> | null = null;
let getActiveTurnCountFn: (() => number) | null = null;
let getSessionCountFn: (() => number) | null = null;

interface HeapSpaceEntry {
  spaceName: string;
  spaceSize: number;
  spaceUsedSize: number;
  spaceAvailableSize: number;
  physicalSpaceSize: number;
}

interface MemorySnapshot {
  timestamp: string;
  activeTurns: number;
  process: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  v8Heap: {
    totalHeapSize: number;
    totalHeapSizeExecutable: number;
    totalPhysicalSize: number;
    totalAvailableSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
    externalMemory: number;
    peakMallocedMemory: number;
    numberOfNativeContexts: number;
    numberOfDetachedContexts: number;
  };
  heapSpaces: HeapSpaceEntry[];
  sessionCount: number;
}

function getProfileDir(): string {
  return path.join(getDataPath(), 'memory-profiles');
}

function captureSnapshot(): MemorySnapshot {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const heapSpaces = v8.getHeapSpaceStatistics();

  let sessionCount = 0;
  try {
    sessionCount = getSessionCountFn?.() ?? 0;
  } catch {
    // Store may not be initialized yet
  }

  const activeTurns = getActiveTurnCountFn?.() ?? 0;

  return {
    timestamp: new Date().toISOString(),
    activeTurns,
    process: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    v8Heap: {
      totalHeapSize: heapStats.total_heap_size,
      totalHeapSizeExecutable: heapStats.total_heap_size_executable,
      totalPhysicalSize: heapStats.total_physical_size,
      totalAvailableSize: heapStats.total_available_size,
      usedHeapSize: heapStats.used_heap_size,
      heapSizeLimit: heapStats.heap_size_limit,
      mallocedMemory: heapStats.malloced_memory,
      externalMemory: heapStats.external_memory,
      peakMallocedMemory: heapStats.peak_malloced_memory,
      numberOfNativeContexts: heapStats.number_of_native_contexts,
      numberOfDetachedContexts: heapStats.number_of_detached_contexts,
    },
    heapSpaces: heapSpaces.map(s => ({
      spaceName: s.space_name,
      spaceSize: s.space_size,
      spaceUsedSize: s.space_used_size,
      spaceAvailableSize: s.space_available_size,
      physicalSpaceSize: s.physical_space_size,
    })),
    sessionCount,
  };
}

async function rotateOldProfiles(): Promise<void> {
  const dir = getProfileDir();
  try {
    const files = await fs.readdir(dir);
    for (const ext of ['.memory.json', '.ram.json']) {
      const matching = files.filter(f => f.endsWith(ext)).sort();
      if (matching.length > MAX_PROFILE_FILES) {
        const toDelete = matching.slice(0, matching.length - MAX_PROFILE_FILES);
        for (const file of toDelete) {
          await fs.unlink(path.join(dir, file));
        }
        log.debug({ deleted: toDelete.length, ext }, 'Rotated old profiles');
      }
    }
  } catch {
    // Dir may not exist yet
  }
}

async function captureAndWrite(): Promise<void> {
  const profileDir = getProfileDir();
  await fs.mkdir(profileDir, { recursive: true });

  try {
    const snapshot = captureSnapshot();

    // Write .memory.json file (V8 heap detail)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(profileDir, `mem-${timestamp}.memory.json`);
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2));

    // Write .ram.json file (full-app process breakdown from ramTelemetryService)
    try {
      const { captureRamSnapshot } = await import('./ramTelemetryService');
      const ramSnapshot = captureRamSnapshot();
      const ramPath = path.join(profileDir, `ram-${timestamp}.ram.json`);
      await fs.writeFile(ramPath, JSON.stringify(ramSnapshot, null, 2));
      log.info(
        {
          profilerChannel: 'app-ram',
          totalWorkingSetMB: ramSnapshot.totals.workingSetMB,
          processCount: ramSnapshot.totals.processCount,
          activeTurns: ramSnapshot.registry.activeTurns,
          processes: ramSnapshot.processes.map(p => ({
            label: p.label,
            workingSetMB: p.workingSetMB,
            cpuPercent: p.cpuPercent,
          })),
        },
        `RAM snapshot: ${ramSnapshot.totals.workingSetMB}MB total across ${ramSnapshot.totals.processCount} processes`
      );
    } catch (ramErr) {
      log.warn({ err: ramErr }, 'Failed to capture RAM snapshot alongside memory profile');
    }

    // Format sizes for logging (MB)
    const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024);

    log.info(
      {
        profilerChannel: 'main-memory',
        activeTurns: snapshot.activeTurns,
        rssMB: toMB(snapshot.process.rss),
        heapUsedMB: toMB(snapshot.process.heapUsed),
        heapTotalMB: toMB(snapshot.process.heapTotal),
        externalMB: toMB(snapshot.process.external),
        arrayBuffersMB: toMB(snapshot.process.arrayBuffers),
        nativeContexts: snapshot.v8Heap.numberOfNativeContexts,
        detachedContexts: snapshot.v8Heap.numberOfDetachedContexts,
        sessionCount: snapshot.sessionCount,
        heapSpaces: snapshot.heapSpaces.map(s => ({
          name: s.spaceName,
          usedMB: toMB(s.spaceUsedSize),
          sizeMB: toMB(s.spaceSize),
        })),
        profileFile: path.basename(filePath),
      },
      `Memory snapshot: RSS ${toMB(snapshot.process.rss)}MB, heap ${toMB(snapshot.process.heapUsed)}/${toMB(snapshot.process.heapTotal)}MB, ${snapshot.sessionCount} sessions`
    );

    await rotateOldProfiles();
  } catch (err) {
    log.error({ err }, 'Memory profile capture failed');
  }
}

/**
 * Initialize the automatic memory profiler.
 * Only call this when REBEL_PERF_MODE=1 and !app.isPackaged.
 *
 * @param getActiveTurnCount Function that returns current active turn count
 * @param getSessionCount Function that returns current session count from index
 */
export function initMemoryProfiler(getActiveTurnCount: () => number, getSessionCount: () => number): void {
  if (intervalTimer) {
    log.warn('Memory profiler already initialized');
    return;
  }

  getActiveTurnCountFn = getActiveTurnCount;
  getSessionCountFn = getSessionCount;

  log.info(
    {
      intervalMs: PROFILE_INTERVAL_MS,
      maxFiles: MAX_PROFILE_FILES,
      profileDir: getProfileDir(),
    },
    'Memory profiler initialized (dev:perf mode)'
  );

  // Schedule periodic captures
  const tick = () => {
    fireAndForget(captureAndWrite(), 'memoryProfilerService.line236');
    intervalTimer = setTimeout(tick, PROFILE_INTERVAL_MS);
  };

  // First capture after one interval (give app time to settle after startup)
  intervalTimer = setTimeout(tick, PROFILE_INTERVAL_MS);
}

/**
 * Stop the memory profiler and clean up.
 */
export function stopMemoryProfiler(): void {
  if (intervalTimer) {
    clearTimeout(intervalTimer);
    intervalTimer = null;
  }
  getActiveTurnCountFn = null;
  getSessionCountFn = null;
  log.info('Memory profiler stopped');
}
