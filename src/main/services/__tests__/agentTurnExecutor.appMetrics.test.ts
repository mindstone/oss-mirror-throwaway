import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  defaultCapabilities,
  setPlatformConfig,
  type PlatformConfig,
  type ProcessMetricSubset,
} from '@core/platform';

const { debugMock } = vi.hoisted(() => ({ debugMock: vi.fn() }));

 
vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: debugMock,
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => actual.logger),
    },
  };
});

import { collectAppMetricsSafely } from '../agentTurnExecutor';

function buildPlatformConfig(
  overrides: Partial<PlatformConfig> = {},
): PlatformConfig {
  return {
    userDataPath: '/tmp/collect-app-metrics-test',
    appPath: '/tmp/collect-app-metrics-test-app',
    tempPath: '/tmp',
    logsPath: '/tmp/collect-app-metrics-test/logs',
    homePath: '/tmp',
    documentsPath: '/tmp/Documents',
    desktopPath: '/tmp/Desktop',
    appDataPath: '/tmp/AppData',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
    capabilities: defaultCapabilities('desktop'),
    ...overrides,
  };
}

describe('collectAppMetricsSafely', () => {
  beforeEach(() => {
    debugMock.mockClear();
  });

  it('returns [] when getAppMetrics is undefined', () => {
    setPlatformConfig(buildPlatformConfig({ getAppMetrics: undefined }));
    expect(collectAppMetricsSafely()).toEqual([]);
    expect(debugMock).not.toHaveBeenCalled();
  });

  it('returns metrics when getAppMetrics is wired', () => {
    const mockMetrics: ProcessMetricSubset[] = [
      {
        type: 'Browser',
        pid: 1,
        cpu: { percentCPUUsage: 5 },
        memory: { workingSetSize: 100 },
      },
      {
        type: 'Tab',
        pid: 2,
        cpu: { percentCPUUsage: 12 },
        memory: { workingSetSize: 250 },
        name: 'renderer:2',
      },
    ];
    setPlatformConfig(buildPlatformConfig({ getAppMetrics: () => mockMetrics }));
    expect(collectAppMetricsSafely()).toEqual(mockMetrics);
    expect(debugMock).not.toHaveBeenCalled();
  });

  it('returns [] and logs at debug when getAppMetrics throws', () => {
    const boom = new Error('boom');
    setPlatformConfig(
      buildPlatformConfig({
        getAppMetrics: () => {
          throw boom;
        },
      }),
    );
    expect(collectAppMetricsSafely()).toEqual([]);
    expect(debugMock).toHaveBeenCalledTimes(1);
    expect(debugMock).toHaveBeenCalledWith(
      { err: boom },
      'getAppMetrics threw — degrading gracefully',
    );
  });
});
