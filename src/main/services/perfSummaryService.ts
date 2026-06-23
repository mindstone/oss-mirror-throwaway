import * as v8 from 'node:v8';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { getWaterfall } from './startupWaterfallService';
import { getLatencyStats } from '../ipc/utils/ipcLatencyTracker';

const log = createScopedLogger({ service: 'perfSummary' });
const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';
const MAX_SUMMARY_FILES = 20;
const SUMMARY_TIMEOUT_MS = 5_000;
const TIMEOUT_RESULT = Symbol('perf-summary-timeout');
const MAX_IPC_CHANNELS_IN_SUMMARY = 10;

interface PerfSummary {
  timestamp: string;
  appVersion: string;
  platform: NodeJS.Platform;
  uptime: number;
  startup: {
    markCount: number;
    totalMs: number;
    waterfall: ReturnType<typeof getWaterfall>;
  } | null;
  ipcLatency: {
    channelCount: number;
    topChannels: ReturnType<typeof getLatencyStats>;
  } | null;
  memory: {
    process: ReturnType<typeof process.memoryUsage>;
    v8Heap: ReturnType<typeof v8.getHeapStatistics>;
  } | null;
  processes: ReturnType<typeof app.getAppMetrics> | null;
  latestCpuProfileSummary: string | null;
  latestRendererProfileSummary: string | null;
}

function getSummaryDir(): string {
  return path.join(getDataPath(), 'perf-summaries');
}

async function findLatestSummaryFile(subDir: string): Promise<string | null> {
  const dirPath = path.join(getDataPath(), subDir);

  try {
    const files = await fs.readdir(dirPath);
    const summaryFiles = files
      .filter((fileName) => fileName.endsWith('.summary.json'))
      .sort();

    if (summaryFiles.length === 0) {
      return null;
    }

    const latestFile = summaryFiles[summaryFiles.length - 1];
    return path.join(dirPath, latestFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
        subDir,
      },
      'Failed to inspect summary directory'
    );
    return null;
  }
}

async function rotateOldSummaries(summaryDir: string): Promise<void> {
  try {
    const files = await fs.readdir(summaryDir);
    const summaryFiles = files
      .filter((fileName) => fileName.startsWith('perf-summary-') && fileName.endsWith('.json'))
      .sort();

    if (summaryFiles.length <= MAX_SUMMARY_FILES) {
      return;
    }

    const toDelete = summaryFiles.slice(0, summaryFiles.length - MAX_SUMMARY_FILES);
    for (const fileName of toDelete) {
      await fs.unlink(path.join(summaryDir, fileName));
    }

    log.debug(
      {
        profilerChannel: 'perf-summary',
        deletedCount: toDelete.length,
      },
      'Rotated old perf summary files'
    );
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to rotate perf summary files'
    );
  }
}

export async function generatePerfSummary(): Promise<string | null> {
  if (!IS_PERF_MODE) {
    return null;
  }

  const timestamp = new Date().toISOString();
  const summary: PerfSummary = {
    timestamp,
    appVersion: 'unknown',
    platform: process.platform,
    uptime: process.uptime(),
    startup: null,
    ipcLatency: null,
    memory: null,
    processes: null,
    latestCpuProfileSummary: null,
    latestRendererProfileSummary: null,
  };

  try {
    summary.appVersion = app.getVersion();
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to collect app version'
    );
  }

  try {
    const waterfall = getWaterfall();
    summary.startup = {
      markCount: waterfall.length,
      totalMs: waterfall[waterfall.length - 1]?.elapsedMs ?? 0,
      waterfall,
    };
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to collect startup waterfall data'
    );
  }

  try {
    const latencyStats = getLatencyStats();
    summary.ipcLatency = {
      channelCount: latencyStats.length,
      topChannels: latencyStats.slice(0, MAX_IPC_CHANNELS_IN_SUMMARY),
    };
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to collect IPC latency data'
    );
  }

  try {
    summary.memory = {
      process: process.memoryUsage(),
      v8Heap: v8.getHeapStatistics(),
    };
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to collect memory data'
    );
  }

  try {
    summary.processes = app.getAppMetrics();
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to collect process metrics'
    );
  }

  summary.latestCpuProfileSummary = await findLatestSummaryFile('cpu-profiles');
  summary.latestRendererProfileSummary = await findLatestSummaryFile('renderer-profiles');

  try {
    const summaryDir = getSummaryDir();
    await fs.mkdir(summaryDir, { recursive: true });

    const fileTimestamp = timestamp.replace(/[:.]/g, '-');
    const summaryPath = path.join(summaryDir, `perf-summary-${fileTimestamp}.json`);
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    await rotateOldSummaries(summaryDir);

    log.info(
      {
        profilerChannel: 'perf-summary',
        summaryPath,
        startupMarks: summary.startup?.markCount ?? 0,
        ipcChannels: summary.ipcLatency?.channelCount ?? 0,
        processCount: summary.processes?.length ?? 0,
      },
      'Performance summary generated'
    );

    return summaryPath;
  } catch (err) {
    log.error(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Failed to write performance summary'
    );
    return null;
  }
}

export async function generateBestEffort(): Promise<void> {
  if (!IS_PERF_MODE) {
    return;
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<typeof TIMEOUT_RESULT>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_RESULT), SUMMARY_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race<string | null | typeof TIMEOUT_RESULT>([
      generatePerfSummary(),
      timeoutPromise,
    ]);

    if (result === TIMEOUT_RESULT) {
      log.warn(
        {
          profilerChannel: 'perf-summary',
          timeoutMs: SUMMARY_TIMEOUT_MS,
        },
        'Best-effort performance summary timed out'
      );
    }
  } catch (err) {
    log.warn(
      {
        err,
        profilerChannel: 'perf-summary',
      },
      'Best-effort performance summary generation failed'
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
