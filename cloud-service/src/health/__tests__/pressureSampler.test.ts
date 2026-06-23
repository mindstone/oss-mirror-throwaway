import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudBootRecord } from '@shared/types/cloudHealth';

const getCachedRssBudgetMbMock = vi.hoisted(() => vi.fn(() => 1000));
const addBreadcrumbMock = vi.hoisted(() => vi.fn());
const captureExceptionMock = vi.hoisted(() => vi.fn());
const captureMessageMock = vi.hoisted(() => vi.fn());
const readFdPressureMock = vi.hoisted(() => vi.fn(() => ({
  status: 'ok' as const,
  source: 'linux-proc-self-fd' as const,
  openFdCount: 321,
  maxFdNumber: 800,
})));

vi.mock('../checks', () => ({
  getCachedRssBudgetMb: () => getCachedRssBudgetMbMock(),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb: addBreadcrumbMock,
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
  }),
}));

vi.mock('@core/utils/fdPressure', () => ({
  readFdPressure: () => readFdPressureMock(),
}));

import {
  __resetCloudPressureSamplerForTests,
  __setCloudPressureBootHistoryPathForTests,
  getCloudPressureBasic,
  invalidateCloudPressureHistoryCache,
  recordCloudBootHistory,
  sampleCloudPressure,
} from '../pressureSampler';

const MB = 1024 * 1024;

function memoryUsageFor(rssMb: number, heapUsedMb = 120, heapTotalMb = 300): NodeJS.MemoryUsage {
  return {
    rss: rssMb * MB,
    heapUsed: heapUsedMb * MB,
    heapTotal: heapTotalMb * MB,
    external: 0,
    arrayBuffers: 0,
  };
}

describe('pressureSampler', () => {
  let tmpDir: string;
  let bootHistoryPath: string;
  let nowMs: number;
  let uptimeSec: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pressure-sampler-'));
    bootHistoryPath = path.join(tmpDir, 'boot-history.json');
    nowMs = 1_700_000_000_000;
    uptimeSec = 600;
    __setCloudPressureBootHistoryPathForTests(bootHistoryPath);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.spyOn(process, 'uptime').mockImplementation(() => uptimeSec);
    vi.spyOn(process, 'memoryUsage').mockReturnValue(memoryUsageFor(600));
    readFdPressureMock.mockReturnValue({
      status: 'ok',
      source: 'linux-proc-self-fd',
      openFdCount: 321,
      maxFdNumber: 800,
    });
    getCachedRssBudgetMbMock.mockReturnValue(1000);
  });

  afterEach(() => {
    __resetCloudPressureSamplerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBootHistory(records: CloudBootRecord[]): void {
    fs.writeFileSync(bootHistoryPath, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8');
  }

  function readBootHistoryRecords(): CloudBootRecord[] {
    const parsed = JSON.parse(fs.readFileSync(bootHistoryPath, 'utf8')) as { records: CloudBootRecord[] };
    return parsed.records;
  }

  it('derives warning and critical states from RSS thresholds', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue(memoryUsageFor(760));
    const warning = await sampleCloudPressure();
    expect(warning.pressure_state).toBe('warning');

    vi.spyOn(process, 'memoryUsage').mockReturnValue(memoryUsageFor(901));
    const critical = await sampleCloudPressure();
    expect(critical.pressure_state).toBe('critical');
  });

  it('includes openFdCount from the shared fd pressure helper', async () => {
    readFdPressureMock.mockReturnValue({
      status: 'ok',
      source: 'linux-proc-self-fd',
      openFdCount: 777,
      maxFdNumber: 1_111,
    });

    const pressure = await sampleCloudPressure();
    expect(pressure.openFdCount).toBe(777);
  });

  it('returns recent_restart=true when process is young and prior boot uptime was short', async () => {
    uptimeSec = 120;
    writeBootHistory([
      { timestamp: nowMs - 240_000, uptime_sec: 120, kind: 'normal' },
      { timestamp: nowMs - 5_000, uptime_sec: 3, kind: 'normal' },
    ]);
    invalidateCloudPressureHistoryCache();

    const pressure = await sampleCloudPressure();
    expect(pressure.recent_restart).toBe(true);
    expect(pressure.recentRestart).toBe(true);
    expect(pressure.pressure_state).toBe('critical');
  });

  it('returns recent_restart=false when prior boot uptime was not short', async () => {
    uptimeSec = 120;
    writeBootHistory([
      { timestamp: nowMs - 240_000, uptime_sec: 900, kind: 'normal' },
      { timestamp: nowMs - 10_000, uptime_sec: 5, kind: 'normal' },
    ]);
    invalidateCloudPressureHistoryCache();

    const pressure = await sampleCloudPressure();
    expect(pressure.recent_restart).toBe(false);
    expect(pressure.recentRestart).toBe(false);
  });

  it('flags oom_recent when non-self-update boot count exceeds one in the pressure window', async () => {
    writeBootHistory([
      { timestamp: nowMs - 25 * 60 * 1000, uptime_sec: 200, kind: 'normal' },
      { timestamp: nowMs - 5 * 60 * 1000, uptime_sec: 80, kind: 'normal' },
    ]);
    invalidateCloudPressureHistoryCache();

    const pressure = await sampleCloudPressure();
    expect(pressure.oom_recent).toBe(true);
    expect(pressure.oomRecent).toBe(true);
    expect(pressure.pressure_state).toBe('critical');
  });

  it('excludes self-update boots from oom_recent counting', async () => {
    writeBootHistory([
      { timestamp: nowMs - 20 * 60 * 1000, uptime_sec: 200, kind: 'self-update' },
      { timestamp: nowMs - 12 * 60 * 1000, uptime_sec: 120, kind: 'self-update' },
      { timestamp: nowMs - 2 * 60 * 1000, uptime_sec: 60, kind: 'normal' },
    ]);
    invalidateCloudPressureHistoryCache();

    const pressure = await sampleCloudPressure();
    expect(pressure.oom_recent).toBe(false);
    expect(pressure.oomRecent).toBe(false);
  });

  it('maps file_missing status and reseeds history on first boot record write', async () => {
    expect(fs.existsSync(bootHistoryPath)).toBe(false);
    const status = recordCloudBootHistory('normal');

    expect(status).toBe('file_missing');
    expect(fs.existsSync(bootHistoryPath)).toBe(true);
    expect(readBootHistoryRecords()).toHaveLength(1);

    const pressure = await sampleCloudPressure();
    expect(pressure.history_status).toBe('file_missing');
    expect(pressure.pressure_state).toBe('ok');
  });

  it('maps parse_error to unknown pressure_state and emits Sentry warning', async () => {
    fs.writeFileSync(bootHistoryPath, '{invalid-json', 'utf8');
    const status = recordCloudBootHistory('normal');
    expect(status).toBe('parse_error');
    expect(captureMessageMock).toHaveBeenCalledWith(
      'cloud.pressure.boot_history.parse_error',
      expect.objectContaining({ level: 'warning' }),
    );

    const pressure = await sampleCloudPressure();
    expect(pressure.history_status).toBe('parse_error');
    expect(pressure.pressure_state).toBe('unknown');
    expect(pressure.state).toBe('unknown');
    expect(readBootHistoryRecords()).toHaveLength(1);
  });

  it('maps empty_file status, emits breadcrumb, and treats pressure as derived', async () => {
    fs.writeFileSync(bootHistoryPath, '', 'utf8');
    vi.spyOn(process, 'memoryUsage').mockReturnValue(memoryUsageFor(760));
    const status = recordCloudBootHistory('normal');
    expect(status).toBe('empty_file');
    expect(addBreadcrumbMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.pressure.boot_history.empty_file',
    }));

    const pressure = await sampleCloudPressure();
    expect(pressure.history_status).toBe('empty_file');
    expect(pressure.pressure_state).toBe('warning');
  });

  it('maps write_failed status and keeps pressure derived from in-memory history', async () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    const status = recordCloudBootHistory('normal');
    expect(status).toBe('write_failed');
    expect(captureExceptionMock).toHaveBeenCalled();

    const pressure = await sampleCloudPressure();
    expect(pressure.history_status).toBe('write_failed');
    expect(pressure.pressure_state).toBe('ok');
  });

  it('uses cache until explicitly invalidated, then reloads from disk', async () => {
    writeBootHistory([{ timestamp: nowMs - 60_000, uptime_sec: 10, kind: 'normal' }]);

    const initial = await sampleCloudPressure();
    expect(initial.history_status).toBe('ok');

    fs.writeFileSync(bootHistoryPath, '{corrupted', 'utf8');
    const cached = await sampleCloudPressure();
    expect(cached.history_status).toBe('ok');

    invalidateCloudPressureHistoryCache();
    const reloaded = await sampleCloudPressure();
    expect(reloaded.history_status).toBe('parse_error');
    expect(reloaded.pressure_state).toBe('unknown');
  });

  it('returns compact basic pressure payload in camelCase', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue(memoryUsageFor(910));

    const basic = await getCloudPressureBasic();
    expect(basic).toEqual({
      state: 'critical',
      oomRecent: false,
      recentRestart: false,
    });
  });

  it('writes boot history via tmp-file rename and truncates to the last 20 entries', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');

    for (let index = 1; index <= 25; index += 1) {
      nowMs = index * 1_000;
      uptimeSec = index;
      recordCloudBootHistory('normal');
    }

    const records = readBootHistoryRecords();
    expect(records).toHaveLength(20);
    expect(records[0]?.timestamp).toBe(6_000);
    expect(records[19]?.timestamp).toBe(25_000);

    expect(writeSpy).toHaveBeenCalledWith(
      `${bootHistoryPath}.tmp`,
      expect.any(String),
      { encoding: 'utf8' },
    );
    expect(renameSpy).toHaveBeenCalledWith(`${bootHistoryPath}.tmp`, bootHistoryPath);
  });
});
