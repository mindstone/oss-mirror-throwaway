import fs from 'node:fs';
import path from 'node:path';
import { getErrorReporter } from '@core/errorReporter';
import { readFdPressure } from '@core/utils/fdPressure';
import { getDataPath } from '@core/utils/dataPaths';
import type {
  CloudBootRecord,
  CloudPressureBasic,
  CloudPressureDetailed,
  CloudPressureHistoryStatus,
  CloudPressureState,
} from '@shared/types/cloudHealth';
import { getCachedRssBudgetMb } from './checks';

const BOOT_HISTORY_FILE_NAME = 'boot-history.json';
const BOOT_HISTORY_MAX_RECORDS = 20;
const RECENT_RESTART_MAX_UPTIME_SEC = 5 * 60;
const PREVIOUS_BOOT_SHORT_UPTIME_SEC = 10 * 60;
const PRESSURE_WINDOW_MS = 30 * 60 * 1000;
const RSS_WARNING_RATIO = 0.75;
const RSS_CRITICAL_RATIO = 0.9;
const BYTES_PER_MB = 1024 * 1024;

type BootHistoryCache = {
  records: CloudBootRecord[];
  historyStatus: CloudPressureHistoryStatus;
  invalidated: boolean;
};

let bootHistoryCache: BootHistoryCache | null = null;
let bootHistoryPathOverride: string | null = null;
let lastReportedHistoryStatus: CloudPressureHistoryStatus | null = null;

function resolveBootHistoryFilePath(): string {
  if (bootHistoryPathOverride) {
    return bootHistoryPathOverride;
  }
  return path.join(getDataPath(), BOOT_HISTORY_FILE_NAME);
}

function toMegabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

function isValidBootKind(value: unknown): value is CloudBootRecord['kind'] {
  return value === 'self-update' || value === 'normal' || value === 'unknown';
}

function normalizeBootRecord(value: unknown): CloudBootRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const timestamp = record.timestamp;
  const uptimeSec = record.uptime_sec;
  const kind = record.kind;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return null;
  }
  if (typeof uptimeSec !== 'number' || !Number.isFinite(uptimeSec) || uptimeSec < 0) {
    return null;
  }
  if (!isValidBootKind(kind)) {
    return null;
  }
  return {
    timestamp,
    uptime_sec: uptimeSec,
    kind,
  };
}

function reportHistoryStatus(status: CloudPressureHistoryStatus): void {
  if (status === lastReportedHistoryStatus) {
    return;
  }
  lastReportedHistoryStatus = status;
  if (status === 'parse_error') {
    getErrorReporter().captureMessage('cloud.pressure.boot_history.parse_error', {
      level: 'warning',
      tags: { surface: 'cloud', service: 'pressureSampler' },
      extra: { bootHistoryPath: resolveBootHistoryFilePath() },
    });
    return;
  }
  if (status === 'empty_file') {
    getErrorReporter().addBreadcrumb({
      category: 'cloud.pressure.boot-history',
      message: 'cloud.pressure.boot_history.empty_file',
      level: 'warning',
      data: { bootHistoryPath: resolveBootHistoryFilePath() },
    });
  }
}

function setBootHistoryCache(next: BootHistoryCache): BootHistoryCache {
  bootHistoryCache = next;
  reportHistoryStatus(next.historyStatus);
  return next;
}

function parseBootHistoryContents(raw: string): {
  records: CloudBootRecord[];
  historyStatus: CloudPressureHistoryStatus;
} {
  if (raw.trim().length === 0) {
    return { records: [], historyStatus: 'empty_file' };
  }
  try {
    const parsed = JSON.parse(raw) as { records?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      return { records: [], historyStatus: 'parse_error' };
    }
    const normalizedRecords = parsed.records.map(normalizeBootRecord);
    if (normalizedRecords.some((record) => record === null)) {
      return { records: [], historyStatus: 'parse_error' };
    }
    return {
      records: (normalizedRecords as CloudBootRecord[]).slice(-BOOT_HISTORY_MAX_RECORDS),
      historyStatus: 'ok',
    };
  } catch {
    return { records: [], historyStatus: 'parse_error' };
  }
}

function readBootHistoryFromDisk(): BootHistoryCache {
  const historyPath = resolveBootHistoryFilePath();
  if (!fs.existsSync(historyPath)) {
    return { records: [], historyStatus: 'file_missing', invalidated: false };
  }
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const parsed = parseBootHistoryContents(raw);
    return {
      records: parsed.records,
      historyStatus: parsed.historyStatus,
      invalidated: false,
    };
  } catch (error) {
    getErrorReporter().captureException(error, {
      level: 'warning',
      tags: { surface: 'cloud', service: 'pressureSampler' },
      extra: { event: 'boot_history_read_failed', bootHistoryPath: historyPath },
    });
    return { records: [], historyStatus: 'parse_error', invalidated: false };
  }
}

function getBootHistoryCache(): BootHistoryCache {
  if (bootHistoryCache && !bootHistoryCache.invalidated) {
    return bootHistoryCache;
  }
  return setBootHistoryCache(readBootHistoryFromDisk());
}

function getPreviousBootRecord(records: CloudBootRecord[]): CloudBootRecord | null {
  if (records.length < 2) {
    return null;
  }
  return records[records.length - 2] ?? null;
}

function countRecentNonSelfUpdateBoots(records: CloudBootRecord[], nowMs: number): number {
  const windowStartMs = nowMs - PRESSURE_WINDOW_MS;
  return records.filter((record) => record.timestamp >= windowStartMs && record.kind !== 'self-update').length;
}

function derivePressureState(args: {
  historyStatus: CloudPressureHistoryStatus;
  oomRecent: boolean;
  recentRestart: boolean;
  rssMb: number;
  rssBudgetMb: number;
}): CloudPressureState {
  // parse_error means historical boot pressure cannot be trusted; we surface
  // unknown explicitly instead of collapsing to "ok" like file_missing.
  if (args.historyStatus === 'parse_error') {
    return 'unknown';
  }
  if (
    args.oomRecent
    || args.recentRestart
    || args.rssMb > args.rssBudgetMb * RSS_CRITICAL_RATIO
  ) {
    return 'critical';
  }
  if (args.rssMb > args.rssBudgetMb * RSS_WARNING_RATIO) {
    return 'warning';
  }
  return 'ok';
}

export function recordCloudBootHistory(kind: CloudBootRecord['kind']): CloudPressureHistoryStatus {
  const previous = readBootHistoryFromDisk();
  reportHistoryStatus(previous.historyStatus);
  const baselineRecords = previous.historyStatus === 'ok' ? previous.records : [];
  const nextRecords = [
    ...baselineRecords,
    {
      timestamp: Date.now(),
      uptime_sec: Math.max(0, Math.round(process.uptime())),
      kind,
    },
  ].slice(-BOOT_HISTORY_MAX_RECORDS);

  const historyPath = resolveBootHistoryFilePath();
  const tmpPath = `${historyPath}.tmp`;
  const payload = `${JSON.stringify({ records: nextRecords }, null, 2)}\n`;

  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf8' });
    fs.renameSync(tmpPath, historyPath);
    const persistedStatus = previous.historyStatus === 'ok' ? 'ok' : previous.historyStatus;
    setBootHistoryCache({
      records: nextRecords,
      historyStatus: persistedStatus,
      invalidated: false,
    });
    return persistedStatus;
  } catch (error) {
    getErrorReporter().captureException(error, {
      level: 'error',
      tags: { surface: 'cloud', service: 'pressureSampler' },
      extra: { event: 'boot_history_write_failed', bootHistoryPath: historyPath },
    });
    setBootHistoryCache({
      records: nextRecords,
      historyStatus: 'write_failed',
      invalidated: false,
    });
    return 'write_failed';
  }
}

export function invalidateCloudPressureHistoryCache(): void {
  if (bootHistoryCache) {
    bootHistoryCache.invalidated = true;
  }
}

export async function sampleCloudPressure(): Promise<CloudPressureDetailed> {
  const mem = process.memoryUsage();
  const rssMb = toMegabytes(mem.rss);
  const heapUsedMb = toMegabytes(mem.heapUsed);
  const heapTotalMb = toMegabytes(mem.heapTotal);
  const uptimeSec = Math.max(0, Math.round(process.uptime()));
  const fdPressure = readFdPressure();
  const openFdCount = fdPressure.status === 'ok' ? fdPressure.openFdCount : null;
  const rssBudgetMb = getCachedRssBudgetMb();
  const history = getBootHistoryCache();
  const previousBoot = getPreviousBootRecord(history.records);
  const nowMs = Date.now();
  const recentRestart = (
    uptimeSec < RECENT_RESTART_MAX_UPTIME_SEC
    && previousBoot !== null
    && previousBoot.uptime_sec < PREVIOUS_BOOT_SHORT_UPTIME_SEC
  );
  const oomRecent = countRecentNonSelfUpdateBoots(history.records, nowMs) > 1;
  const state = derivePressureState({
    historyStatus: history.historyStatus,
    oomRecent,
    recentRestart,
    rssMb,
    rssBudgetMb,
  });

  return {
    state,
    oomRecent,
    recentRestart,
    pressure_state: state,
    rss_mb: rssMb,
    heap_used_mb: heapUsedMb,
    heap_total_mb: heapTotalMb,
    uptime_sec: uptimeSec,
    openFdCount,
    recent_restart: recentRestart,
    oom_recent: oomRecent,
    pressure_window_ms: PRESSURE_WINDOW_MS,
    history_status: history.historyStatus,
    rss_budget_mb: rssBudgetMb,
  };
}

export async function getCloudPressureBasic(): Promise<CloudPressureBasic> {
  const pressure = await sampleCloudPressure();
  return {
    state: pressure.state,
    oomRecent: pressure.oomRecent,
    recentRestart: pressure.recentRestart,
  };
}

export function __setCloudPressureBootHistoryPathForTests(filePath: string | null): void {
  bootHistoryPathOverride = filePath;
  bootHistoryCache = null;
  lastReportedHistoryStatus = null;
}

export function __resetCloudPressureSamplerForTests(): void {
  bootHistoryCache = null;
  bootHistoryPathOverride = null;
  lastReportedHistoryStatus = null;
}
