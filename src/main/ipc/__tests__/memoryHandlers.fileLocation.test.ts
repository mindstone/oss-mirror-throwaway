import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileLocation } from '@rebel/shared';

const { registeredHandlers, mockWarn, mockError, repairEntryPathMock, repairStalePathsMock } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  repairEntryPathMock: vi.fn(),
  repairStalePathsMock: vi.fn(),
}));

const safetyMock = vi.hoisted(() => ({
  getPendingMemoryApprovals: vi.fn(),
  handleMemoryWriteApprovalResponse: vi.fn(),
  removePendingMemoryApproval: vi.fn(),
  addPendingMemoryApproval: vi.fn(),
}));

const cosPendingMock = vi.hoisted(() => ({
  listPendingFiles: vi.fn(),
  getPendingFile: vi.fn(),
  getPendingContent: vi.fn(),
  publishPendingFile: vi.fn(),
  deletePendingFile: vi.fn(),
  keepPendingFilePrivate: vi.fn(),
  publishWithConflictResolution: vi.fn(),
  detectPendingConflict: vi.fn(),
  canonicalizePath: vi.fn((value: string) => value),
}));

const scanSpacesMock = vi.hoisted(() => vi.fn());
const resolveFileLocationMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: mockWarn,
    error: mockError,
  }),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock();
});

vi.mock('@core/services/fileLocation', () => ({
  resolveFileLocation: (...args: unknown[]) => resolveFileLocationMock(...args),
  FileLocationResolverError: class FileLocationResolverError extends Error {
    readonly code: string;
    readonly inputPath: string;

    constructor(code: string, inputPath: string, message: string) {
      super(message);
      this.name = 'FileLocationResolverError';
      this.code = code;
      this.inputPath = inputPath;
    }
  },
}));

vi.mock('../../services/memoryHistoryStore', () => ({
  getMemoryHistory: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0, bySpace: [] }),
  getMemoryHistoryEntry: vi.fn().mockReturnValue(null),
  removeMemoryHistoryEntry: vi.fn(),
  repairStaleFilePathsIfNeeded: (...args: unknown[]) => repairStalePathsMock(...args),
  repairMemoryHistoryEntryPath: (...args: unknown[]) => repairEntryPathMock(...args),
}));

vi.mock('../../services/safety', () => safetyMock);
vi.mock('../../services/spaceService', () => ({
  scanSpaces: (...args: unknown[]) => scanSpacesMock(...args),
}));
vi.mock('../../services/safety/cosPendingService', () => cosPendingMock);

vi.mock('../../services/meetingBot/transcriptEventBus', () => ({
  emitDeferredTranscriptSaved: vi.fn().mockReturnValue(false),
  emitTranscriptSavedFromMeta: vi.fn(),
  removeDeferredTranscriptSaved: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/workspace' }),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  },
}));

vi.mock('../../services/safety/automationPendingItemsTracker', () => ({
  resolveItem: vi.fn(),
}));

vi.mock('../../services/safety/automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    classifySharedSkillPath: vi.fn().mockResolvedValue(null),
    writeManagedSkillFile: vi.fn(),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn().mockReturnValue({ id: 'user-1' }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

import { registerMemoryHandlers } from '../memoryHandlers';

const IN_SPACE_LOCATION: FileLocation = {
  kind: 'in-space',
  spaceName: 'General',
  spaceWorkspacePath: 'General',
  spaceRelativePath: 'skills/workflows/weekly/SKILL.md',
  workspaceRelativePath: 'General/skills/workflows/weekly/SKILL.md',
  fileName: 'SKILL.md',
  absolutePath: '/workspace/General/skills/workflows/weekly/SKILL.md',
};

const OUTSIDE_LOCATION: FileLocation = {
  kind: 'outside-workspace',
  absolutePath: '/tmp/outside.md',
  fileName: 'outside.md',
  outsideCategory: 'outside',
};

const RENAMED_SPACE_LOCATION: FileLocation = {
  kind: 'in-space',
  spaceName: 'General',
  spaceWorkspacePath: 'General Renamed',
  spaceRelativePath: 'skills/workflows/weekly/SKILL.md',
  workspaceRelativePath: 'General Renamed/skills/workflows/weekly/SKILL.md',
  fileName: 'SKILL.md',
  absolutePath: '/workspace/General Renamed/skills/workflows/weekly/SKILL.md',
};

function makePendingFile(overrides: Partial<{
  id: string;
  pendingDestination: string;
  originalSpace: string;
}> = {}) {
  return {
    id: overrides.id ?? 'pending-1',
    frontmatter: {
      pending_destination: overrides.pendingDestination ?? 'General/skills/workflows/weekly/SKILL.md',
      original_space: overrides.originalSpace ?? 'General',
      session_id: 'session-1',
      base_hash: 'hash-1',
      summary: 'Pending summary',
      staged_at: '2026-04-19T12:00:00.000Z',
      blocked_by: undefined,
      approval_kind: undefined,
      author_label: undefined,
      tool_use_id: undefined,
      pending_transcript_meta: undefined,
    },
  };
}

function makePendingApproval(overrides: Partial<{
  toolUseId: string;
  filePath: string;
  spaceName: string;
  location: FileLocation;
}> = {}) {
  return {
    toolUseId: overrides.toolUseId ?? 'tool-1',
    originalTurnId: 'orig-turn-1',
    originalSessionId: 'orig-session-1',
    turnId: 'turn-1',
    sessionId: 'session-1',
    filePath: overrides.filePath ?? '/workspace/General/skills/workflows/weekly/SKILL.md',
    spaceName: overrides.spaceName ?? 'General',
    summary: 'summary',
    content: 'content',
    timestamp: 123,
    spacePath: undefined,
    location: overrides.location,
  };
}

describe('memoryHandlers Stage 2b FileLocation producers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    repairEntryPathMock.mockReturnValue(true);
    repairStalePathsMock.mockResolvedValue({ repaired: 0, totalScanned: 0, skipped: true });

    scanSpacesMock.mockResolvedValue([
      {
        name: 'General',
        path: 'General',
        absolutePath: '/workspace/General',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      },
    ]);

    cosPendingMock.detectPendingConflict.mockResolvedValue({
      hasConflict: false,
      fileModifiedSinceStaging: false,
      newFileConflict: false,
    });

    safetyMock.getPendingMemoryApprovals.mockReturnValue([]);
    resolveFileLocationMock.mockResolvedValue(IN_SPACE_LOCATION);

    registerMemoryHandlers();
  });

  it('memory:staging-get-all returns FileLocation on every row', async () => {
    cosPendingMock.listPendingFiles.mockResolvedValue([
      makePendingFile({ id: 'pending-a' }),
      makePendingFile({ id: 'pending-b', pendingDestination: '/tmp/outside.md' }),
    ]);

    resolveFileLocationMock
      .mockResolvedValueOnce(IN_SPACE_LOCATION)
      .mockResolvedValueOnce(OUTSIDE_LOCATION);

    const handler = registeredHandlers.get('memory:staging-get-all');
    expect(handler).toBeDefined();

    const result = await handler!() as { files: Array<{ location?: FileLocation }> };
    expect(result.files).toHaveLength(2);
    expect(result.files.every((row) => row.location != null)).toBe(true);
  });

  it('memory:staging-get-all keeps spacePath non-empty for every row', async () => {
    cosPendingMock.listPendingFiles.mockResolvedValue([
      makePendingFile({ id: 'pending-c' }),
      makePendingFile({ id: 'pending-d', pendingDestination: '/tmp/outside.md' }),
    ]);

    resolveFileLocationMock
      .mockResolvedValueOnce(IN_SPACE_LOCATION)
      .mockResolvedValueOnce(OUTSIDE_LOCATION);

    const handler = registeredHandlers.get('memory:staging-get-all');
    const result = await handler!() as { files: Array<{ spacePath: string }> };

    expect(result.files).toHaveLength(2);
    expect(result.files.every((row) => row.spacePath.trim().length > 0)).toBe(true);
  });

  it('memory:get-pending-approvals returns FileLocation on every row', async () => {
    safetyMock.getPendingMemoryApprovals.mockReturnValue([
      makePendingApproval({ toolUseId: 'tool-1' }),
      makePendingApproval({ toolUseId: 'tool-2', filePath: '/tmp/outside.md', spaceName: 'General' }),
    ]);

    resolveFileLocationMock
      .mockResolvedValueOnce(IN_SPACE_LOCATION)
      .mockResolvedValueOnce(OUTSIDE_LOCATION);

    const handler = registeredHandlers.get('memory:get-pending-approvals');
    const result = await handler!() as Array<{ location?: FileLocation; spacePath?: string }>;

    expect(result).toHaveLength(2);
    expect(result.every((row) => row.location != null)).toBe(true);
    expect(result.every((row) => typeof row.spacePath === 'string' && row.spacePath.length > 0)).toBe(true);
  });

  it('memory:get-pending-approvals lazily projects missing location without writing to store', async () => {
    const legacyRecord = makePendingApproval({
      toolUseId: 'tool-legacy',
      location: undefined,
    });
    safetyMock.getPendingMemoryApprovals.mockReturnValue([legacyRecord]);
    resolveFileLocationMock.mockResolvedValue(IN_SPACE_LOCATION);

    const handler = registeredHandlers.get('memory:get-pending-approvals');
    const result = await handler!() as Array<{ location: FileLocation }>;

    expect(result).toHaveLength(1);
    expect(result[0]?.location).toEqual(IN_SPACE_LOCATION);
    expect((legacyRecord as { location?: FileLocation }).location).toBeUndefined();
    expect(safetyMock.addPendingMemoryApproval).not.toHaveBeenCalled();
  });

  it('memory:get-pending-approvals recomputes current location instead of trusting stale persisted location', async () => {
    scanSpacesMock.mockResolvedValue([
      {
        name: 'General',
        path: 'General Renamed',
        absolutePath: '/workspace/General Renamed',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      },
    ]);

    safetyMock.getPendingMemoryApprovals.mockReturnValue([
      makePendingApproval({
        toolUseId: 'tool-stale-location',
        filePath: '/workspace/General Renamed/skills/workflows/weekly/SKILL.md',
        location: {
          ...IN_SPACE_LOCATION,
          spaceWorkspacePath: 'General',
          workspaceRelativePath: 'General/skills/workflows/weekly/SKILL.md',
          absolutePath: '/workspace/General/skills/workflows/weekly/SKILL.md',
        },
      }),
    ]);
    resolveFileLocationMock.mockResolvedValue(RENAMED_SPACE_LOCATION);

    const handler = registeredHandlers.get('memory:get-pending-approvals');
    const result = await handler!() as Array<{ location: FileLocation; spacePath: string }>;

    expect(resolveFileLocationMock).toHaveBeenCalledWith(
      '/workspace/General Renamed/skills/workflows/weekly/SKILL.md',
      expect.any(Array),
      { coreDirectory: '/workspace' },
    );
    expect(result).toEqual([
      expect.objectContaining({
        location: RENAMED_SPACE_LOCATION,
        spacePath: 'General Renamed/skills/workflows/weekly/SKILL.md',
      }),
    ]);
  });

  it('memory:repair-entry-path forwards updates and stays idempotent', async () => {
    const handler = registeredHandlers.get('memory:repair-entry-path');
    expect(handler).toBeDefined();

    const payload = {
      entryId: 'entry-123',
      repairedFilePath: 'chief-of-staff/memory/topics/weekly.md',
    };

    const firstResult = await handler!(undefined, payload) as { success: boolean };
    const secondResult = await handler!(undefined, payload) as { success: boolean };

    expect(firstResult).toEqual({ success: true });
    expect(secondResult).toEqual({ success: true });
    expect(repairEntryPathMock).toHaveBeenCalledTimes(2);
    expect(repairEntryPathMock).toHaveBeenNthCalledWith(1, 'entry-123', 'chief-of-staff/memory/topics/weekly.md');
    expect(repairEntryPathMock).toHaveBeenNthCalledWith(2, 'entry-123', 'chief-of-staff/memory/topics/weekly.md');
  });

  it('dedups fallback warning for repeated outside-workspace staging rows', async () => {
    const repeatedDestination = '/tmp/stage2b-dedup-outside.md';
    cosPendingMock.listPendingFiles.mockResolvedValue([
      makePendingFile({ id: 'pending-dedup', pendingDestination: repeatedDestination }),
    ]);
    resolveFileLocationMock.mockResolvedValue({
      ...OUTSIDE_LOCATION,
      absolutePath: repeatedDestination,
      fileName: 'stage2b-dedup-outside.md',
    } satisfies FileLocation);

    const handler = registeredHandlers.get('memory:staging-get-all');
    await handler!();
    await handler!();

    const fallbackWarnings = mockWarn.mock.calls.filter(
      ([, message]) => message === 'FileLocation fell back to outside-workspace',
    );
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0]?.[0]).toMatchObject({
      pendingDestination: repeatedDestination,
      handler: 'memory:staging-get-all',
    });
  });
});
