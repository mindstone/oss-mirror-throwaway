import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedSkillTarget } from '../sharedSkillMutationService';

const mockCallTool = vi.fn();
const mockWithSuperMcpClient = vi.fn(async (fn: (client: { callTool: typeof mockCallTool }) => Promise<unknown>) => {
  return fn({ callTool: mockCallTool });
});

const mockGetSettings = vi.fn();
const mockScanSpaces = vi.fn();
const mockGetMcpServerNames = vi.fn();
const mockReadMcpServerDetails = vi.fn();
const mockClassifySharedSkillPath = vi.fn();
const mockWriteManagedSkillFile = vi.fn();
const mockTrackMainEvent = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockReadDriveFileIdFromXattr = vi.fn();

vi.mock('../mcpService', () => ({
  withSuperMcpClient: (fn: (client: { callTool: typeof mockCallTool }) => Promise<unknown>) => mockWithSuperMcpClient(fn),
  getTextEntryFromToolResult: (result: unknown) =>
    (result as { content?: Array<{ type: string; text: string }> }).content?.find((entry) => entry.type === 'text') ?? null,
  resolveMcpConfigPath: vi.fn(() => '/tmp/super-mcp-router.json'),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => mockGetSettings(),
}));

vi.mock('../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
}));

vi.mock('../mcpConfigManager', () => ({
  getMcpServerNames: (...args: unknown[]) => mockGetMcpServerNames(...args),
  readMcpServerDetails: (...args: unknown[]) => mockReadMcpServerDetails(...args),
}));

vi.mock('../sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    classifySharedSkillPath: (...args: unknown[]) => mockClassifySharedSkillPath(...args),
    writeManagedSkillFile: (...args: unknown[]) => mockWriteManagedSkillFile(...args),
  },
}));

vi.mock('../driveFileIdLookup', () => ({
  readDriveFileIdFromXattr: (...args: unknown[]) => mockReadDriveFileIdFromXattr(...args),
}));

const mockGetCachedRevisionHashes = vi.fn();
const mockSetCachedRevisionHashes = vi.fn();
const mockPruneCachedRevisionHashes = vi.fn();

vi.mock('@core/services/driveRevisionHashCache', () => ({
  getCachedRevisionHashes: (...args: unknown[]) => mockGetCachedRevisionHashes(...args),
  setCachedRevisionHashes: (...args: unknown[]) => mockSetCachedRevisionHashes(...args),
  pruneCachedRevisionHashes: (...args: unknown[]) => mockPruneCachedRevisionHashes(...args),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: () => mockGetCurrentUser(),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('../../analytics', () => ({
  trackMainEvent: (...args: unknown[]) => mockTrackMainEvent(...args),
  getOrGenerateAnonymousId: () => 'anon-test-id',
}));

const { driveSkillHistoryService } = await import('../driveSkillHistoryService');

function makeTarget(overrides: Partial<SharedSkillTarget> = {}): SharedSkillTarget {
  return {
    absolutePath: '/tmp/workspace/shared-space/SKILL.md',
    relativePath: 'shared-space/SKILL.md',
    sharing: 'restricted',
    spaceName: 'Shared Space',
    spacePath: 'shared-space',
    spaceAbsolutePath: '/tmp/workspace/shared-space',
    shape: 'file',
    ...overrides,
  };
}

function enqueueToolResult(result: unknown): void {
  mockCallTool.mockResolvedValueOnce({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          package_id: 'GoogleWorkspace-owner-example-com',
          tool_id: 'GoogleWorkspace-owner-example-com__mock_tool',
          result,
        }),
      },
    ],
  });
}

describe('driveSkillHistoryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mocks that use *.mockResolvedValueOnce across tests need their
    // enqueued response stack reset explicitly — clearAllMocks only
    // clears call history, not pending Once queues.
    mockCallTool.mockReset();
    mockClassifySharedSkillPath.mockReset();
    mockScanSpaces.mockReset();
    mockReadDriveFileIdFromXattr.mockReset();
    mockGetSettings.mockReturnValue({
      coreDirectory: '/tmp/workspace',
      spaces: [
        {
          path: 'shared-space',
          name: 'Shared Space',
          type: 'team',
          sharing: 'restricted',
          isSymlink: true,
          sourcePath: null,
          storageProvider: 'google_drive',
          createdAt: Date.now(),
        },
      ],
    });
    mockGetMcpServerNames.mockResolvedValue(['GoogleWorkspace-owner-example-com']);
    mockReadMcpServerDetails.mockResolvedValue({ email: 'owner@example.com' });
    mockScanSpaces.mockResolvedValue([
      {
        path: 'shared-space',
        absolutePath: '/tmp/workspace/shared-space',
        sharing: 'restricted',
        sourcePath: null,
        emails: ['owner@example.com'],
      },
    ]);
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'owner@example.com' });
    mockWriteManagedSkillFile.mockResolvedValue({
      conflict: false,
      currentHash: 'hash-after-restore',
      path: '/tmp/workspace/shared-space/SKILL.md',
      updatedAt: 123,
      content: 'restored body',
    });
    // Default existing tests to the search-fallback path. Tests that
    // exercise the xattr fast path override this explicitly.
    mockReadDriveFileIdFromXattr.mockResolvedValue(null);
    // Default: no cached hashes — every revision triggers a download
    // for dedup. Tests that want to exercise the cached path override
    // this before the call.
    mockGetCachedRevisionHashes.mockReturnValue({});
  });

  it('returns drive-history-unavailable when space is not Google Drive-backed', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/tmp/workspace',
      spaces: [
        {
          path: 'shared-space',
          name: 'Shared Space',
          type: 'team',
          sharing: 'restricted',
          isSymlink: false,
          sourcePath: null,
          storageProvider: 'local',
          createdAt: Date.now(),
        },
      ],
    });
    mockClassifySharedSkillPath.mockResolvedValueOnce(
      makeTarget({ absolutePath: '/tmp/workspace/shared-space/local-skill.md', relativePath: 'shared-space/local-skill.md' }),
    );

    const result = await driveSkillHistoryService.listVersions('shared-space/local-skill.md', '/tmp/workspace');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/^drive-history-unavailable:/);
    }
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('maps Drive revisions into existing summary payload shape', async () => {
    mockClassifySharedSkillPath.mockResolvedValueOnce(makeTarget());

    enqueueToolResult({
      success: true,
      data: {
        files: [{ id: 'drive-file-1', name: 'SKILL.md', modifiedTime: '2026-04-20T10:00:00.000Z' }],
      },
    });
    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          {
            id: 'rev-2',
            modifiedTime: '2026-04-21T09:00:00.000Z',
            lastModifyingUser: { displayName: 'Alicia', emailAddress: 'alicia@example.com' },
          },
          {
            id: 'rev-1',
            modifiedTime: '2026-04-20T09:00:00.000Z',
            lastModifyingUser: { displayName: 'Ben', emailAddress: 'ben@example.com' },
          },
        ],
      },
    });
    // Dedup pass downloads each revision's content. Different bytes →
    // no collapse, both revisions survive.
    enqueueToolResult({ success: true, data: 'content-rev-2', encoding: 'text' });
    enqueueToolResult({ success: true, data: 'content-rev-1', encoding: 'text' });

    const result = await driveSkillHistoryService.listVersions('shared-space/SKILL.md', '/tmp/workspace');
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.versions).toHaveLength(2);
    expect(result.versions[0]).toEqual(
      expect.objectContaining({
        snapshotId: 'rev-2',
        actorLabel: 'Alicia',
        actorEmail: 'alicia@example.com',
        skillWorkspacePath: 'shared-space/SKILL.md',
        restoredFromSnapshotId: null,
      }),
    );
    expect(mockSetCachedRevisionHashes).toHaveBeenCalledWith(
      'drive-file-1',
      expect.objectContaining({
        'rev-1': expect.objectContaining({ hash: expect.any(String) }),
        'rev-2': expect.objectContaining({ hash: expect.any(String) }),
      }),
    );
  });

  it('collapses adjacent revisions with identical content into a single entry', async () => {
    mockClassifySharedSkillPath.mockResolvedValueOnce(
      makeTarget({
        absolutePath: '/tmp/workspace/shared-space/dedup-skill.md',
        relativePath: 'shared-space/dedup-skill.md',
      }),
    );
    mockReadDriveFileIdFromXattr.mockResolvedValueOnce('dedup-file-id');

    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          { id: 'rev-c', modifiedTime: '2026-04-21T12:00:00.000Z', lastModifyingUser: { displayName: 'Third' } },
          { id: 'rev-b', modifiedTime: '2026-04-21T11:00:00.000Z', lastModifyingUser: { displayName: 'Second' } },
          { id: 'rev-a', modifiedTime: '2026-04-21T10:00:00.000Z', lastModifyingUser: { displayName: 'First' } },
        ],
      },
    });
    // rev-a and rev-b have identical content (a sync no-op). rev-c
    // has different content. Dedup should drop rev-b (newer
    // duplicate of rev-a). Downloads are dispatched in Drive's list
    // order — newest first: rev-c, rev-b, rev-a.
    enqueueToolResult({ success: true, data: 'body-Y', encoding: 'text' }); // rev-c
    enqueueToolResult({ success: true, data: 'body-X', encoding: 'text' }); // rev-b
    enqueueToolResult({ success: true, data: 'body-X', encoding: 'text' }); // rev-a

    const result = await driveSkillHistoryService.listVersions(
      'shared-space/dedup-skill.md',
      '/tmp/workspace',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const ids = result.versions.map((v) => v.snapshotId);
    // Newest first ordering at the UI layer; rev-b collapsed away.
    expect(ids).toEqual(['rev-c', 'rev-a']);
  });

  it('skips download when all revision hashes are already cached', async () => {
    mockClassifySharedSkillPath.mockResolvedValueOnce(
      makeTarget({
        absolutePath: '/tmp/workspace/shared-space/cached-skill.md',
        relativePath: 'shared-space/cached-skill.md',
      }),
    );
    mockReadDriveFileIdFromXattr.mockResolvedValueOnce('cached-file-id');

    mockGetCachedRevisionHashes.mockReturnValueOnce({
      'rev-a': { hash: 'hashA', cachedAt: 1 },
      'rev-b': { hash: 'hashA', cachedAt: 2 },
      'rev-c': { hash: 'hashB', cachedAt: 3 },
    });

    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          { id: 'rev-c', modifiedTime: '2026-04-21T12:00:00.000Z', lastModifyingUser: { displayName: 'Third' } },
          { id: 'rev-b', modifiedTime: '2026-04-21T11:00:00.000Z', lastModifyingUser: { displayName: 'Second' } },
          { id: 'rev-a', modifiedTime: '2026-04-21T10:00:00.000Z', lastModifyingUser: { displayName: 'First' } },
        ],
      },
    });

    const result = await driveSkillHistoryService.listVersions(
      'shared-space/cached-skill.md',
      '/tmp/workspace',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Only list_file_revisions was called — no download_file_revision
    // needed because every revision hash came from the persistent cache.
    const toolIds = mockCallTool.mock.calls.map(
      (call) => (call[0] as { arguments?: { tool_id?: string } }).arguments?.tool_id,
    );
    expect(toolIds.filter((id) => id && id.endsWith('download_file_revision'))).toHaveLength(0);
    expect(result.versions.map((v) => v.snapshotId)).toEqual(['rev-c', 'rev-a']);
    expect(mockSetCachedRevisionHashes).not.toHaveBeenCalled();
  });

  it('uses the xattr file_id as the primary resolution path and skips MCP search', async () => {
    mockClassifySharedSkillPath.mockResolvedValueOnce(
      makeTarget({
        absolutePath: '/tmp/workspace/shared-space/xattr-skill.md',
        relativePath: 'shared-space/xattr-skill.md',
      }),
    );
    mockReadDriveFileIdFromXattr.mockResolvedValueOnce('xattr-file-id-123');

    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          {
            id: 'rev-xattr',
            modifiedTime: '2026-04-21T09:00:00.000Z',
            lastModifyingUser: { displayName: 'Alicia', emailAddress: 'alicia@example.com' },
          },
        ],
      },
    });

    const result = await driveSkillHistoryService.listVersions('shared-space/xattr-skill.md', '/tmp/workspace');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]?.snapshotId).toBe('rev-xattr');

    // The fast path must call exactly one MCP tool (list_file_revisions)
    // and must NOT trigger any search_drive_files traversal.
    const toolIds = mockCallTool.mock.calls.map(
      (call) => (call[0] as { arguments?: { tool_id?: string } }).arguments?.tool_id,
    );
    expect(toolIds).toHaveLength(1);
    expect(toolIds[0]).toMatch(/list_file_revisions$/);

    expect(mockCallTool.mock.calls[0]?.[0]).toMatchObject({
      arguments: expect.objectContaining({
        args: expect.objectContaining({ file_id: 'xattr-file-id-123' }),
      }),
    });
  });

  it('prefers user-local associated accounts over README colleague emails for Drive package selection', async () => {
    mockGetSettings.mockReturnValue({
      coreDirectory: '/tmp/workspace',
      spaces: [
        {
          path: 'shared-space',
          name: 'Shared Space',
          type: 'team',
          sharing: 'restricted',
          isSymlink: true,
          sourcePath: null,
          storageProvider: 'google_drive',
          associatedAccounts: ['[external-email]'],
          createdAt: Date.now(),
        },
      ],
    });
    mockScanSpaces.mockResolvedValueOnce([
      {
        path: 'shared-space',
        absolutePath: '/tmp/workspace/shared-space',
        sharing: 'restricted',
        sourcePath: null,
        emails: ['[external-email]'],
      },
    ]);
    mockGetMcpServerNames.mockResolvedValueOnce([
      'GoogleWorkspace-colleague-acmecorp-com',
      'GoogleWorkspace-current-acmecorp-com',
    ]);
    mockReadMcpServerDetails.mockImplementation(async (_configPath, name: string) => ({
      email: name.includes('current') ? '[external-email]' : '[external-email]',
    }));
    mockGetCurrentUser.mockReturnValue({ id: 'user-current', email: '[external-email]' });
    mockClassifySharedSkillPath.mockResolvedValueOnce(makeTarget({
      absolutePath: '/tmp/workspace/shared-space/current-skill.md',
      relativePath: 'shared-space/current-skill.md',
    }));
    mockReadDriveFileIdFromXattr.mockResolvedValueOnce('xattr-current-file-id');

    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          {
            id: 'rev-current',
            modifiedTime: '2026-04-21T09:00:00.000Z',
            lastModifyingUser: { displayName: 'Current', emailAddress: '[external-email]' },
          },
        ],
      },
    });

    const result = await driveSkillHistoryService.listVersions('shared-space/SKILL.md', '/tmp/workspace');
    expect(result.success).toBe(true);

    expect(mockCallTool.mock.calls[0]?.[0]).toMatchObject({
      arguments: expect.objectContaining({
        package_id: 'GoogleWorkspace-current-acmecorp-com',
        args: expect.objectContaining({ email: '[external-email]' }),
      }),
    });
  });

  it('falls back to in-space path matching when sourcePath prefix is stale', async () => {
    mockScanSpaces.mockResolvedValueOnce([
      {
        path: 'shared-space',
        absolutePath: '/tmp/workspace/shared-space',
        sharing: 'restricted',
        sourcePath: '/Users/test/Library/CloudStorage/GoogleDrive-owner@example.com/Shared drives/IncorrectRoot/shared-space',
        emails: ['owner@example.com'],
      },
    ]);
    mockClassifySharedSkillPath.mockResolvedValueOnce(
      makeTarget({
        absolutePath: '/tmp/workspace/shared-space/skills/recruiter/SKILL.md',
        relativePath: 'shared-space/skills/recruiter/SKILL.md',
      }),
    );

    enqueueToolResult({ success: true, data: { files: [] } });
    enqueueToolResult({
      success: true,
      data: { files: [{ id: 'folder-skills', name: 'skills', mimeType: 'application/vnd.google-apps.folder' }] },
    });
    enqueueToolResult({
      success: true,
      data: { files: [{ id: 'folder-recruiter', name: 'recruiter', mimeType: 'application/vnd.google-apps.folder' }] },
    });
    enqueueToolResult({
      success: true,
      data: { files: [{ id: 'drive-file-fallback', name: 'SKILL.md', modifiedTime: '2026-04-21T09:00:00.000Z' }] },
    });
    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          {
            id: 'rev-fallback',
            modifiedTime: '2026-04-21T09:00:00.000Z',
            lastModifyingUser: { displayName: 'Alicia', emailAddress: 'alicia@example.com' },
          },
        ],
      },
    });

    const result = await driveSkillHistoryService.listVersions('shared-space/skills/recruiter/SKILL.md', '/tmp/workspace');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.versions).toHaveLength(1);

    const queries = mockCallTool.mock.calls
      .map((call) => (call[0] as { arguments?: { args?: { options?: { query?: string } } } }).arguments?.args?.options?.query)
      .filter((query): query is string => typeof query === 'string');
    expect(queries).toContain("name = 'IncorrectRoot'");
    expect(queries).toContain("name = 'skills'");
  });

  it('restores a selected Drive revision through sharedSkillMutationService', async () => {
    mockClassifySharedSkillPath.mockResolvedValue(makeTarget({ absolutePath: '/tmp/workspace/shared-space/restore-skill.md', relativePath: 'shared-space/restore-skill.md' }));

    enqueueToolResult({
      success: true,
      data: { files: [{ id: 'drive-file-restore', name: 'restore-skill.md' }] },
    });
    enqueueToolResult({
      success: true,
      data: {
        revisions: [
          {
            id: 'rev-restore',
            modifiedTime: '2026-04-21T09:00:00.000Z',
            lastModifyingUser: { displayName: 'Alicia', emailAddress: 'alicia@example.com' },
          },
        ],
      },
    });
    enqueueToolResult({
      success: true,
      data: '---\ndescription: Restored\n---\nBody from revision\n',
      encoding: 'text',
    });

    const result = await driveSkillHistoryService.restoreVersion(
      'shared-space/restore-skill.md',
      'rev-restore',
      '/tmp/workspace',
      { kind: 'human', user: { id: 'user-1', email: 'owner@example.com', name: 'Owner', image: null } },
    );

    expect(result.success).toBe(true);
    expect(mockWriteManagedSkillFile).toHaveBeenCalledWith(
      '/tmp/workspace/shared-space/restore-skill.md',
      expect.stringContaining('Body from revision'),
      '/tmp/workspace',
      expect.objectContaining({ kind: 'human' }),
      expect.objectContaining({
        restoreLineage: expect.objectContaining({
          restoredFromVersionId: 'rev-restore',
        }),
      }),
    );
    expect(mockTrackMainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'skill_restored',
      }),
    );
  });
});
