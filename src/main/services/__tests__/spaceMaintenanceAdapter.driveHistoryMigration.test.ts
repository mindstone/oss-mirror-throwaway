import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockScanSpaces = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/user-data'),
  },
  shell: {
    trashItem: vi.fn(async () => undefined),
  },
}));

vi.mock('../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
}));

const { createDesktopDriveHistoryMigrationDeps } = await import('../spaceMaintenanceAdapter');

describe('createDesktopDriveHistoryMigrationDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only includes non-private Google Drive-backed shared spaces', async () => {
    mockScanSpaces.mockResolvedValue([
      {
        path: 'gdrive-shared',
        absolutePath: '/Users/test/Library/CloudStorage/GoogleDrive-test/My Drive/gdrive-shared',
        sharing: 'restricted',
        sourcePath: '/Users/test/Library/CloudStorage/GoogleDrive-test/My Drive/gdrive-shared',
      },
      {
        path: 'onedrive-shared',
        absolutePath: '/Users/test/workspace/onedrive-shared',
        sharing: 'restricted',
        sourcePath: '/Users/test/OneDrive - Team/onedrive-shared',
      },
      {
        path: 'private-gdrive',
        absolutePath: '/Users/test/Library/CloudStorage/GoogleDrive-test/My Drive/private-gdrive',
        sharing: 'private',
        sourcePath: '/Users/test/Library/CloudStorage/GoogleDrive-test/My Drive/private-gdrive',
      },
      {
        path: 'local-shared',
        absolutePath: '/Users/test/workspace/local-shared',
        sharing: 'restricted',
      },
    ]);

    const deps = createDesktopDriveHistoryMigrationDeps();
    const roots = await deps.listSharedSpaceRoots('/Users/test/workspace');

    expect(roots).toEqual([
      '/Users/test/Library/CloudStorage/GoogleDrive-test/My Drive/gdrive-shared',
    ]);
  });
});
