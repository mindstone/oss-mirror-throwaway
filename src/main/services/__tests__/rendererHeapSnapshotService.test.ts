import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const tempDataPath = '/tmp/rebel-renderer-heap-test';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const mockApp = {
  getAppMetrics: vi.fn(),
  getVersion: vi.fn(() => '0.4.46-test'),
};

const mockFsState = {
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  statfsBytes: 10 * 1024 * 1024 * 1024,
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => tempDataPath,
  isPackaged: () => false,
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(async (dir: string) => {
      mockFsState.dirs.add(dir);
    }),
    statfs: vi.fn(async () => ({
      bavail: Math.floor(mockFsState.statfsBytes / 4096),
      bsize: 4096,
    })),
    stat: vi.fn(async (filePath: string) => {
      const content = mockFsState.files.get(filePath);
      if (content === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return { size: Buffer.byteLength(content) };
    }),
    writeFile: vi.fn(async (filePath: string, content: string) => {
      mockFsState.files.set(filePath, content);
    }),
    readdir: vi.fn(async (dir: string) => {
      const prefix = `${dir}${path.sep}`;
      return Array.from(mockFsState.files.keys())
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => filePath.slice(prefix.length));
    }),
    unlink: vi.fn(async (filePath: string) => {
      mockFsState.files.delete(filePath);
    }),
  },
}));

function makeWindow(options: {
  pid?: number;
  destroyed?: boolean;
  snapshotContent?: string;
  takeHeapSnapshot?: (filePath: string) => Promise<void>;
} = {}) {
  const pid = options.pid ?? 2002;
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    webContents: {
      getOSProcessId: vi.fn(() => pid),
      takeHeapSnapshot: vi.fn(options.takeHeapSnapshot ?? (async (filePath: string) => {
        mockFsState.files.set(filePath, options.snapshotContent ?? '{"snapshot":{"meta":{}}}');
      })),
    },
  };
}

describe('rendererHeapSnapshotService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:34:56.789Z'));
    mockFsState.files.clear();
    mockFsState.dirs.clear();
    mockFsState.statfsBytes = 10 * 1024 * 1024 * 1024;
    mockApp.getVersion.mockReturnValue('0.4.46-test');
    mockApp.getAppMetrics.mockReturnValue([
      {
        pid: 2002,
        type: 'Tab',
        memory: { workingSetSize: 512 * 1024 },
        cpu: { percentCPUUsage: 0 },
        creationTime: 1,
      },
    ]);
  });

  afterEach(async () => {
    const mod = await import('../rendererHeapSnapshotService');
    mod._resetRendererHeapSnapshotServiceForTesting();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('captures a heap snapshot and writes the sidecar shape', async () => {
    const mod = await import('../rendererHeapSnapshotService');
    const win = makeWindow();
    mod.initRendererHeapSnapshotService(() => win as never);

    const result = await mod.captureRendererHeapSnapshot({ trigger: 'manual', label: 'baseline T0' });

    expect(result.status).toBe('captured');
    expect(result.status === 'captured' ? result.path : '').toContain('renderer-heap-2026-06-11T12-34-56-789Z-baseline-T0.heapsnapshot');
    expect(win.webContents.takeHeapSnapshot).toHaveBeenCalledOnce();
    expect(result.status === 'captured' ? result.rendererWorkingSetMB : undefined).toBe(512);
    expect(result.status === 'captured' ? result.snapshotFileBytes : 0).toBeGreaterThan(0);

    const metaPath = result.status === 'captured' ? result.metaPath : '';
    const meta = JSON.parse(mockFsState.files.get(metaPath) ?? '{}');
    expect(meta).toEqual({
      timestamp: '2026-06-11T12:34:56.789Z',
      appVersion: '0.4.46-test',
      label: 'baseline T0',
      trigger: 'manual',
      rendererWorkingSetMB: 512,
      snapshotFileBytes: result.status === 'captured' ? result.snapshotFileBytes : 0,
      durationMs: result.status === 'captured' ? result.durationMs : 0,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        label: 'baseline T0',
        rendererWorkingSetMB: 512,
      }),
      'Renderer heap snapshot captured',
    );
  });

  it('returns skipped_no_window when the main window is missing', async () => {
    const mod = await import('../rendererHeapSnapshotService');
    mod.initRendererHeapSnapshotService(() => null);

    const result = await mod.captureRendererHeapSnapshot({ trigger: 'manual' });

    expect(result).toEqual({
      status: 'skipped_no_window',
      error: 'No renderer window is available for heap snapshot capture.',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { trigger: 'manual', label: undefined },
      'Renderer heap snapshot skipped: no window',
    );
  });

  it('returns skipped_low_disk before capture when free space is below twice the renderer working set', async () => {
    const mod = await import('../rendererHeapSnapshotService');
    const win = makeWindow();
    mod.initRendererHeapSnapshotService(() => win as never);
    mockFsState.statfsBytes = 600 * 1024 * 1024;

    const result = await mod.captureRendererHeapSnapshot({ trigger: 'manual', label: 'low disk' });

    expect(result).toMatchObject({
      status: 'skipped_low_disk',
      rendererWorkingSetMB: 512,
    });
    expect(result.status === 'skipped_low_disk' ? result.requiredFreeBytes : 0).toBe(1024 * 1024 * 1024);
    expect(win.webContents.takeHeapSnapshot).not.toHaveBeenCalled();
  });

  it('uses a conservative disk guard when renderer metrics are unavailable', async () => {
    const mod = await import('../rendererHeapSnapshotService');
    const win = makeWindow({ pid: 9009 });
    mod.initRendererHeapSnapshotService(() => win as never);
    mockApp.getAppMetrics.mockReturnValue([]);
    mockFsState.statfsBytes = 1500 * 1024 * 1024;

    const result = await mod.captureRendererHeapSnapshot({ trigger: 'manual' });

    expect(result).toMatchObject({
      status: 'skipped_low_disk',
      requiredFreeBytes: 2 * 1024 * 1024 * 1024,
    });
    expect(win.webContents.takeHeapSnapshot).not.toHaveBeenCalled();
  });

  it('returns failed when Electron takeHeapSnapshot throws', async () => {
    const mod = await import('../rendererHeapSnapshotService');
    const win = makeWindow({
      takeHeapSnapshot: async () => {
        throw new Error('snapshot failed');
      },
    });
    mod.initRendererHeapSnapshotService(() => win as never);

    const result = await mod.captureRendererHeapSnapshot({ trigger: 'watchdog', label: 'auto-T0' });

    expect(result).toEqual({ status: 'failed', error: 'snapshot failed' });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        trigger: 'watchdog',
        label: 'auto-T0',
      }),
      'Renderer heap snapshot capture failed',
    );
  });

  it('rotates old snapshots and sidecars, keeping the newest four pairs', async () => {
    const mod = await import('../rendererHeapSnapshotService');
    const win = makeWindow();
    mod.initRendererHeapSnapshotService(() => win as never);
    const dir = path.join(tempDataPath, 'heap-snapshots');

    for (let i = 0; i < 4; i += 1) {
      const snapshotPath = path.join(dir, `renderer-heap-2026-06-11T12-0${i}-00-000Z-old-${i}.heapsnapshot`);
      mockFsState.files.set(snapshotPath, '{}');
      mockFsState.files.set(`${snapshotPath}.meta.json`, '{}');
    }

    const result = await mod.captureRendererHeapSnapshot({ trigger: 'manual', label: 'new' });

    expect(result.status).toBe('captured');
    const snapshots = Array.from(mockFsState.files.keys()).filter((filePath) => filePath.endsWith('.heapsnapshot'));
    const sidecars = Array.from(mockFsState.files.keys()).filter((filePath) => filePath.endsWith('.heapsnapshot.meta.json'));
    expect(snapshots).toHaveLength(4);
    expect(sidecars).toHaveLength(4);
    expect(snapshots.some((filePath) => filePath.includes('old-0'))).toBe(false);
  });

  it('denies the IPC channel when REBEL_PERF_MODE is not enabled', async () => {
    vi.stubEnv('REBEL_PERF_MODE', '');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.doMock('../../ipc/utils/registerHandler', () => ({
      registerHandler: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    }));
    vi.doMock('../rendererHeapSnapshotService', () => ({
      captureRendererHeapSnapshot: vi.fn(),
      _resetRendererHeapSnapshotServiceForTesting: vi.fn(),
    }));

    const { registerSystemHandlers } = await import('../../ipc/systemHandlers');
    registerSystemHandlers({ getSettings: () => ({}) as AppSettings });

    const handler = handlers.get('system:heap-snapshot-capture');
    expect(handler).toBeDefined();
    const result = await handler?.({}, { trigger: 'manual', label: 'denied' });

    expect(result).toEqual({
      status: 'failed',
      error: 'Renderer heap snapshots require REBEL_PERF_MODE=1.',
    });
  });

  it('allows the IPC channel when REBEL_PERF_MODE is enabled', async () => {
    vi.stubEnv('REBEL_PERF_MODE', '1');
    const captureRendererHeapSnapshot = vi.fn(async () => ({
      status: 'captured' as const,
      path: '/tmp/snapshot.heapsnapshot',
      metaPath: '/tmp/snapshot.heapsnapshot.meta.json',
      snapshotFileBytes: 123,
      durationMs: 45,
    }));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.doMock('../../ipc/utils/registerHandler', () => ({
      registerHandler: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    }));
    vi.doMock('../rendererHeapSnapshotService', () => ({
      captureRendererHeapSnapshot,
      _resetRendererHeapSnapshotServiceForTesting: vi.fn(),
    }));

    const { registerSystemHandlers } = await import('../../ipc/systemHandlers');
    registerSystemHandlers({ getSettings: () => ({}) as AppSettings });

    const handler = handlers.get('system:heap-snapshot-capture');
    const request = { trigger: 'manual' as const, label: 'allowed' };
    const result = await handler?.({}, request);

    expect(captureRendererHeapSnapshot).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      status: 'captured',
      path: '/tmp/snapshot.heapsnapshot',
      metaPath: '/tmp/snapshot.heapsnapshot.meta.json',
      snapshotFileBytes: 123,
      durationMs: 45,
    });
  });
});
