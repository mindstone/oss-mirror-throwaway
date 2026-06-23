import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockScanSpaces = vi.fn();
const mockDetect = vi.fn();
const mockBroadcast = vi.fn();

let surfaced = false;
let completed = false;
let lastRunId: string | null = null;

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/user-data') },
  shell: { trashItem: vi.fn(async () => undefined) },
}));

vi.mock('../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
}));

vi.mock('@core/services/spaceMaintenanceService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    detectConflictCopyCleanup: (...args: unknown[]) => mockDetect(...args),
  };
});

vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock('@core/services/conflictCopyCleanupMigration', () => ({
  isConflictCleanupSurfaced: () => surfaced,
  isConflictCleanupCompleted: () => completed,
  markConflictCleanupSurfaced: (runId: string) => {
    surfaced = true;
    lastRunId = runId;
  },
  markConflictCleanupCompleted: () => {
    completed = true;
  },
}));

const {
  scheduleConflictCopyCleanupDetection,
  detectConflictCopyCleanupAllSpacesFromMain,
} = await import('../spaceMaintenanceAdapter');

const emptyPlan = { toQuarantine: [], needsReview: [] };
const nonEmptyPlan = {
  toQuarantine: [
    { relPath: 'notes/a (1).md', immediateParentRelPath: 'notes/a.md', label: 'numbered-copy', provider: 'unknown', hash: 'h1' },
    { relPath: 'notes/b (1).md', immediateParentRelPath: 'notes/b.md', label: 'numbered-copy', provider: 'unknown', hash: 'h2' },
  ],
  needsReview: [
    { relPath: 'notes/c (1).md', label: 'copy-of', provider: 'unknown', immediateParentRelPath: 'notes/c.md', reason: 'differing-from-parent' },
  ],
};

describe('scheduleConflictCopyCleanupDetection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    surfaced = false;
    completed = false;
    lastRunId = null;
  });

  // F2/F3 run-once contract: scanning is gated by `completed`, the toast by
  // `surfaced`. Re-detect across launches until the backlog is gone; toast once.

  it('scans when NOT completed (completed gates scanning, surfaced does not)', async () => {
    surfaced = true; // already surfaced — must STILL scan
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/w/space-a', name: 'A' }]);
    mockDetect.mockResolvedValue({ runId: 'run-x', plan: nonEmptyPlan, manifestPath: '/m' });

    await scheduleConflictCopyCleanupDetection('/w');

    expect(mockScanSpaces).toHaveBeenCalledTimes(1);
  });

  it('empty plan → marks completed (next launch skips scanning); no broadcast', async () => {
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/w/space-a', name: 'A' }]);
    mockDetect.mockResolvedValue({ runId: 'run-1', plan: emptyPlan, manifestPath: '/m' });

    await scheduleConflictCopyCleanupDetection('/w');

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(surfaced).toBe(false);
    expect(completed).toBe(true);

    // Next launch: completed gate short-circuits before any scan.
    mockScanSpaces.mockClear();
    await scheduleConflictCopyCleanupDetection('/w');
    expect(mockScanSpaces).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('non-empty FIRST run → broadcasts one summary + flips surfaced (not completed)', async () => {
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/w/space-a', name: 'A' }]);
    mockDetect.mockResolvedValue({ runId: 'run-7', plan: nonEmptyPlan, manifestPath: '/m' });

    await scheduleConflictCopyCleanupDetection('/w');

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockBroadcast.mock.calls[0];
    expect(channel).toBe('conflict-cleanup:available');
    expect(payload).toMatchObject({
      runId: 'run-7',
      spaceRootAbsPath: '/w/space-a',
      spaceName: 'A',
      quarantineCount: 2,
      needsReviewCount: 1,
    });
    expect(payload.sample).toEqual(['notes/a (1).md', 'notes/b (1).md']);
    expect(surfaced).toBe(true);
    expect(completed).toBe(false); // backlog still present → NOT completed
    expect(lastRunId).toBe('run-7');
  });

  it('non-empty SECOND run (surfaced, not completed) → scans, no re-broadcast', async () => {
    surfaced = true; // first run already surfaced
    mockScanSpaces.mockResolvedValue([{ absolutePath: '/w/space-a', name: 'A' }]);
    mockDetect.mockResolvedValue({ runId: 'run-9', plan: nonEmptyPlan, manifestPath: '/m' });

    await scheduleConflictCopyCleanupDetection('/w');

    expect(mockScanSpaces).toHaveBeenCalledTimes(1); // still scans
    expect(mockBroadcast).not.toHaveBeenCalled(); // but does NOT re-broadcast
    expect(completed).toBe(false); // backlog still present → NOT completed
  });

  it('skips scanning entirely when completed', async () => {
    completed = true;
    await scheduleConflictCopyCleanupDetection('/w');
    expect(mockScanSpaces).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('detectConflictCopyCleanupAllSpacesFromMain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    surfaced = false;
    completed = false;
  });

  it('returns one summary per affected space and omits empty plans', async () => {
    mockScanSpaces.mockResolvedValue([
      { absolutePath: '/w/space-a', name: 'A' },
      { absolutePath: '/w/space-b', name: 'B' },
    ]);
    mockDetect
      .mockResolvedValueOnce({ runId: 'r-a', plan: nonEmptyPlan, manifestPath: '/m' })
      .mockResolvedValueOnce({ runId: 'r-b', plan: emptyPlan, manifestPath: '/m' });

    const summaries = await detectConflictCopyCleanupAllSpacesFromMain('/w');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ runId: 'r-a', spaceName: 'A', quarantineCount: 2 });
  });
});
