import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockWriteManagedSkillFile = vi.fn();
const mockAttachManagedWriteObserver = vi.fn();
const mockInvalidateSpaceScanCache = vi.fn();
const mockBroadcast = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    writeManagedSkillFile: (...args: unknown[]) => mockWriteManagedSkillFile(...args),
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock('../../services/skillChangeNotificationService', () => ({
  skillChangeNotificationService: {
    attachManagedWriteObserver: (...args: unknown[]) => mockAttachManagedWriteObserver(...args),
    listNotifications: vi.fn().mockResolvedValue([]),
    dismissNotification: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../services/spaceService', async () => {
  const actual = await vi.importActual<typeof import('../../services/spaceService')>('../../services/spaceService');
  return {
    ...actual,
    invalidateSpaceScanCache: (...args: unknown[]) => mockInvalidateSpaceScanCache(...args),
  };
});

vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn().mockReturnValue({ id: 'user-1', email: 'owner@example.com', name: null }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      refreshLicenseTier: vi.fn(),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../../tracking', () => ({
  mainTracking: {
    skillCreated: vi.fn(),
    workArtifactCreated: vi.fn(),
  },
}));

const { registerLibraryHandlers } = await import('../libraryHandlers');

function getHandler<T>(
  channel: string,
): (event: unknown, payload: unknown) => Promise<T> {
  const handler = registeredHandlers.get(channel);
  expect(handler).toBeDefined();
  if (!handler) {
    throw new Error(`Expected ${channel} handler to be registered`);
  }
  return handler as (event: unknown, payload: unknown) => Promise<T>;
}

describe('library mutators invalidate scanSpacesReadOnly cache when paths affect spaces', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    mockWriteManagedSkillFile.mockResolvedValue(null);

    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'library-space-cache-mutator-'));
    const settings = { coreDirectory: workspaceRoot } as unknown as AppSettings;

    registerLibraryHandlers({
      getSettings: () => settings,
      getSettingsStore: () => ({ store: settings }),
    });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('library:write-file invalidates for root markdown writes', async () => {
    const writeHandler = getHandler<{ result: 'ok' | 'conflict' | 'failed' }>('library:write-file');

    const result = await writeHandler({}, {
      path: 'README.md',
      content: '# Updated workspace README',
    });

    expect(result.result).toBe('ok');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:write-file:path-affects-spaces',
    );
  });

  it('library:create-file invalidates for root markdown creates', async () => {
    const createFileHandler = getHandler<{ path: string; name: string }>('library:create-file');

    const result = await createFileHandler({}, {
      fileName: 'AGENTS.md',
    });

    expect(result.name).toBe('AGENTS.md');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:create-file:path-affects-spaces',
    );
  });

  it('library:create-folder invalidates for top-level folder creates', async () => {
    const createFolderHandler = getHandler<{ path: string; name: string }>('library:create-folder');

    const result = await createFolderHandler({}, {
      folderName: 'New Space Folder',
    });

    expect(result.name).toBe('New Space Folder');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:create-folder:path-affects-spaces',
    );
  });

  it('library:rename-item invalidates for top-level folder renames', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'Old Space'), { recursive: true });
    const renameHandler = getHandler<{ path: string; name?: string }>('library:rename-item');

    const result = await renameHandler({}, {
      itemPath: 'Old Space',
      newName: 'Renamed Space',
    });

    expect(result.name).toBe('Renamed Space');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:rename-item:path-affects-spaces',
    );
  });

  it('library:move-item invalidates when moving a root markdown file', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'MoveMe.md'), '# move me', 'utf8');
    await fs.mkdir(path.join(workspaceRoot, 'Archive'), { recursive: true });
    const moveHandler = getHandler<{ path: string; moved?: boolean }>('library:move-item');

    const result = await moveHandler({}, {
      itemPath: 'MoveMe.md',
      targetDirectoryPath: 'Archive',
    });

    expect(result.moved).toBe(true);
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:move-item:path-affects-spaces',
    );
  });

  it('library:delete-item invalidates for top-level folder deletes', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'Delete Me Space'), { recursive: true });
    const deleteHandler = getHandler<{ success: boolean }>('library:delete-item');

    const result = await deleteHandler({}, {
      itemPath: 'Delete Me Space',
    });

    expect(result.success).toBe(true);
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:delete-item:path-affects-spaces',
    );
  });

  it('library:create-folder invalidates when creating work/<company>', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'work'), { recursive: true });
    const createFolderHandler = getHandler<{ path: string; name: string }>('library:create-folder');

    const result = await createFolderHandler({}, {
      folderName: 'Acme Corp',
      parentPath: 'work',
    });

    expect(result.name).toBe('Acme Corp');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:create-folder:path-affects-spaces',
    );
  });

  it('library:create-folder invalidates when creating work/<company>/<space>', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'work', 'Acme Corp'), { recursive: true });
    const createFolderHandler = getHandler<{ path: string; name: string }>('library:create-folder');

    const result = await createFolderHandler({}, {
      folderName: 'Project Alpha',
      parentPath: 'work/Acme Corp',
    });

    expect(result.name).toBe('Project Alpha');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:create-folder:path-affects-spaces',
    );
  });

  it('library:write-file invalidates for work/<company>/README.md writes', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'work', 'Acme Corp'), { recursive: true });
    const writeHandler = getHandler<{ result: 'ok' | 'conflict' | 'failed' }>('library:write-file');

    const result = await writeHandler({}, {
      path: 'work/Acme Corp/README.md',
      content: '# Acme Corp\n\nrebel_space_description: client space',
    });

    expect(result.result).toBe('ok');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:write-file:path-affects-spaces',
    );
  });

  it('library:write-file invalidates for work/<company>/<space>/AGENTS.md writes', async () => {
    await fs.mkdir(
      path.join(workspaceRoot, 'work', 'Acme Corp', 'Project Alpha'),
      { recursive: true },
    );
    const writeHandler = getHandler<{ result: 'ok' | 'conflict' | 'failed' }>('library:write-file');

    const result = await writeHandler({}, {
      path: 'work/Acme Corp/Project Alpha/AGENTS.md',
      content: '# Agents',
    });

    expect(result.result).toBe('ok');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:write-file:path-affects-spaces',
    );
  });

  it('library:rename-item invalidates when renaming work/<company>/<space>', async () => {
    await fs.mkdir(
      path.join(workspaceRoot, 'work', 'Acme Corp', 'Old Project'),
      { recursive: true },
    );
    const renameHandler = getHandler<{ path: string; name?: string }>('library:rename-item');

    const result = await renameHandler({}, {
      itemPath: 'work/Acme Corp/Old Project',
      newName: 'New Project',
    });

    expect(result.name).toBe('New Project');
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:rename-item:path-affects-spaces',
    );
  });

  it('library:delete-item invalidates when deleting work/<company>', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'work', 'Defunct Corp'), { recursive: true });
    const deleteHandler = getHandler<{ success: boolean }>('library:delete-item');

    const result = await deleteHandler({}, {
      itemPath: 'work/Defunct Corp',
    });

    expect(result.success).toBe(true);
    expect(mockInvalidateSpaceScanCache).toHaveBeenCalledWith(
      workspaceRoot,
      'library:delete-item:path-affects-spaces',
    );
  });

  it('does NOT invalidate for unrelated work/<company>/<space>/<deeper>/file.md writes', async () => {
    await fs.mkdir(
      path.join(workspaceRoot, 'work', 'Acme Corp', 'Project Alpha', 'memory'),
      { recursive: true },
    );
    const writeHandler = getHandler<{ result: 'ok' | 'conflict' | 'failed' }>('library:write-file');

    const result = await writeHandler({}, {
      path: 'work/Acme Corp/Project Alpha/memory/notes.md',
      content: '# notes',
    });

    expect(result.result).toBe('ok');
    expect(mockInvalidateSpaceScanCache).not.toHaveBeenCalled();
  });
});
