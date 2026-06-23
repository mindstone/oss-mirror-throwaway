import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

// F1 (IPC security): the `cleanup-execute` handler must reject a renderer-supplied
// `spaceRootAbsPath` that is not a currently-known scanned space root — no move,
// fail-soft error result. A real scanned root proceeds to the destructive engine.

const { handlers, logger } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

const mockScanSpaces = vi.fn();
const mockExecuteFromMain = vi.fn();
const mockDetectAllSpaces = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn);
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => logger,
}));

vi.mock('../../services/spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
}));

vi.mock('../../services/spaceMaintenanceAdapter', () => ({
  detectConflictCopyCleanupAllSpacesFromMain: (...args: unknown[]) =>
    mockDetectAllSpaces(...args),
  executeConflictCopyCleanupFromMain: (...args: unknown[]) => mockExecuteFromMain(...args),
  resetNeedsReviewFromMain: vi.fn(),
  runDailyMaintenanceFromMain: vi.fn(),
}));

import { registerSpaceMaintenanceHandlers } from '../spaceMaintenanceHandlers';

const SETTINGS = { coreDirectory: '/core' } as unknown as AppSettings;
const FAKE_EVENT = {} as any;

function getExecuteHandler(): (...args: any[]) => any {
  const handler = handlers.get('space-maintenance:cleanup-execute');
  if (!handler) {
    throw new Error('cleanup-execute handler was not registered');
  }
  return handler;
}

const OK_RESULT = {
  quarantined: 3,
  skipped: 0,
  errors: [],
  leaseContended: false,
  quarantineRootAbsPath: '/core/space-a/.rebel/conflicts-cleanup/2026-06-02',
};

describe('space-maintenance:cleanup-execute — spaceRootAbsPath validation (F1)', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerSpaceMaintenanceHandlers({ getSettings: () => SETTINGS });
  });

  it('rejects an unknown/arbitrary spaceRootAbsPath (no move, error result)', async () => {
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/core/space-a', name: 'A' }]);

    const result = await getExecuteHandler()(FAKE_EVENT, {
      runId: 'run-1',
      spaceRootAbsPath: '/etc/evil',
    });

    expect(mockExecuteFromMain).not.toHaveBeenCalled();
    expect(result.quarantined).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('not a known space root');
  });

  it('proceeds for a real scanned space root', async () => {
    mockScanSpaces.mockResolvedValue([
      { absolutePath: '/core/space-a', name: 'A' },
      { absolutePath: '/core/space-b', name: 'B' },
    ]);
    mockExecuteFromMain.mockResolvedValue(OK_RESULT);

    const result = await getExecuteHandler()(FAKE_EVENT, {
      runId: 'run-1',
      spaceRootAbsPath: '/core/space-b',
    });

    expect(mockExecuteFromMain).toHaveBeenCalledTimes(1);
    expect(mockExecuteFromMain).toHaveBeenCalledWith('/core/space-b', 'run-1');
    expect(result.quarantined).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('accepts a non-normalized root that resolves to a known space (no escape regression)', async () => {
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/core/space-a', name: 'A' }]);
    mockExecuteFromMain.mockResolvedValue(OK_RESULT);

    const result = await getExecuteHandler()(FAKE_EVENT, {
      runId: 'run-1',
      spaceRootAbsPath: '/core/space-a/../space-a',
    });

    expect(mockExecuteFromMain).toHaveBeenCalledWith('/core/space-a', 'run-1');
    expect(result.quarantined).toBe(3);
  });

  it('fails soft on a malformed request (destructure/shape validation is inside try)', async () => {
    // No spaceRootAbsPath at all — must not throw, must return a fail-soft result.
    const result = await getExecuteHandler()(FAKE_EVENT, { runId: 'run-1' });

    expect(mockScanSpaces).not.toHaveBeenCalled();
    expect(mockExecuteFromMain).not.toHaveBeenCalled();
    expect(result.quarantined).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails soft when no core directory is configured', async () => {
    handlers.clear();
    registerSpaceMaintenanceHandlers({
      getSettings: () => ({ coreDirectory: null }) as unknown as AppSettings,
    });
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/core/space-a', name: 'A' }]);

    const result = await getExecuteHandler()(FAKE_EVENT, {
      runId: 'run-1',
      spaceRootAbsPath: '/core/space-a',
    });

    expect(mockScanSpaces).not.toHaveBeenCalled();
    expect(mockExecuteFromMain).not.toHaveBeenCalled();
    expect(result.quarantined).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
