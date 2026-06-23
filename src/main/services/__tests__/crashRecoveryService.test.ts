import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

// Stub logger
const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

// Mutable state for mocks
let mockWasCleanExit = true;
let mockCaptureMainMessageWithLogs: Mock;
let storeData: { lastReported: number } = { lastReported: 0 };
let mockExportRecentLogs: Mock;

const setupModule = async () => {
  vi.resetModules();
  await initTestPlatformConfig();

  // Override StoreFactory to use test-controlled storeData
  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(() => ({
    get: (key: string, defaultValue?: unknown) => {
      const val = storeData[key as keyof typeof storeData];
      return val !== undefined ? val : defaultValue;
    },
    set: (key: string, value: unknown) => {
      storeData[key as keyof typeof storeData] = value as (typeof storeData)[keyof typeof storeData];
    },
    has: (key: string) => key in storeData,
    delete: (key: string) => { delete (storeData as Record<string, unknown>)[key]; },
    clear: () => { storeData = { lastReported: 0 }; },
    get store() { return storeData; },
    set store(v: Record<string, unknown>) { Object.assign(storeData, v); },
    get path() { return '/tmp/test-stores/crash-recovery.json'; },
  }) as any);

  // Mock logger
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));

  // Mock gracefulShutdown
  vi.doMock('../gracefulShutdown', () => ({
    wasCleanExit: () => mockWasCleanExit,
  }));

  // Mock logExportService
  mockExportRecentLogs = vi.fn().mockResolvedValue({
    files: [{ filename: 'mindstone-rebel.log', content: '{"level":"info","msg":"test log"}' }],
    totalLines: 1,
    timeWindow: '60 minutes',
  });
  vi.doMock('../logExportService', () => ({
    exportRecentLogs: mockExportRecentLogs,
  }));

  // Mock sentry
  mockCaptureMainMessageWithLogs = vi.fn().mockReturnValue('event-id-123');
  vi.doMock('../../sentry', () => ({
    captureMainMessageWithLogs: mockCaptureMainMessageWithLogs,
  }));

  return await import('../crashRecoveryService');
};

describe('crashRecoveryService', () => {
  beforeEach(() => {
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
    mockWasCleanExit = true;
    storeData = { lastReported: 0 };
  });

  describe('reportUncleanShutdownIfNeeded', () => {
    it('returns early if wasCleanExit() is true', async () => {
      mockWasCleanExit = true;
      const service = await setupModule();

      await service.reportUncleanShutdownIfNeeded();

      expect(mockCaptureMainMessageWithLogs).not.toHaveBeenCalled();
      expect(mockExportRecentLogs).not.toHaveBeenCalled();
    });

    it('returns early if in cooldown', async () => {
      mockWasCleanExit = false;
      // Set lastReported to recent time (within 1-hour cooldown)
      storeData = { lastReported: Date.now() - 5 * 60 * 1000 }; // 5 minutes ago

      const service = await setupModule();

      await service.reportUncleanShutdownIfNeeded();

      expect(mockCaptureMainMessageWithLogs).not.toHaveBeenCalled();
      expect(stubLogger.info).toHaveBeenCalledWith(
        'Skipping crash report - within cooldown period'
      );
    });

    it('calls Sentry with correct message, tags, and attachment', async () => {
      mockWasCleanExit = false;
      storeData = { lastReported: 0 }; // No cooldown

      const service = await setupModule();

      await service.reportUncleanShutdownIfNeeded();

      expect(mockCaptureMainMessageWithLogs).toHaveBeenCalledTimes(1);

      const [message, logsText, context] = mockCaptureMainMessageWithLogs.mock.calls[0];
      expect(message).toBe('Unclean shutdown detected from previous session');
      expect(logsText).toContain('test log');
      expect(context.level).toBe('warning');
      expect(context.tags).toEqual({
        area: 'startup',
        component: 'crash-recovery',
        crash_detection: 'automatic',
      });
      expect(context.extra).toMatchObject({
        logTimeWindow: '60 minutes',
        logLines: 1,
      });
    });

    it('updates cooldown store after reporting', async () => {
      mockWasCleanExit = false;
      storeData = { lastReported: 0 };

      const before = Date.now();
      const service = await setupModule();

      await service.reportUncleanShutdownIfNeeded();

      const after = Date.now();

      // Verify cooldown timestamp was updated to approximately now
      expect(storeData.lastReported).toBeGreaterThanOrEqual(before);
      expect(storeData.lastReported).toBeLessThanOrEqual(after);
    });

    it('does not throw if exportRecentLogs fails', async () => {
      mockWasCleanExit = false;
      storeData = { lastReported: 0 };

      const service = await setupModule();
      mockExportRecentLogs.mockRejectedValueOnce(new Error('disk read failed'));

      // Should not throw — internal try/catch handles errors
      await expect(service.reportUncleanShutdownIfNeeded()).resolves.toBeUndefined();

      expect(stubLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to report unclean shutdown to Sentry'
      );
    });

    it('reports after cooldown expires', async () => {
      mockWasCleanExit = false;
      // Set lastReported to 2 hours ago (outside 1-hour cooldown)
      storeData = { lastReported: Date.now() - 2 * 60 * 60 * 1000 };

      const service = await setupModule();

      await service.reportUncleanShutdownIfNeeded();

      expect(mockCaptureMainMessageWithLogs).toHaveBeenCalledTimes(1);
    });

    it('calls exportRecentLogs with correct parameters', async () => {
      mockWasCleanExit = false;
      storeData = { lastReported: 0 };

      const service = await setupModule();

      await service.reportUncleanShutdownIfNeeded();

      expect(mockExportRecentLogs).toHaveBeenCalledWith({
        logWindowMinutes: 60,
        maxLinesPerFile: 1000,
        filterLevel: 'all',
      });
    });

    it('joins multiple log files into single NDJSON string', async () => {
      mockWasCleanExit = false;
      storeData = { lastReported: 0 };

      const service = await setupModule();

      mockExportRecentLogs.mockResolvedValueOnce({
        files: [
          { filename: 'file1.log', content: '{"line":"1"}' },
          { filename: 'file2.log', content: '{"line":"2"}' },
        ],
        totalLines: 2,
        timeWindow: '60 minutes',
      });

      await service.reportUncleanShutdownIfNeeded();

      const [, logsText] = mockCaptureMainMessageWithLogs.mock.calls[0];
      expect(logsText).toBe('{"line":"1"}\n{"line":"2"}');
    });
  });
});
