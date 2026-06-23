/**
 * Regression tests for REBEL-1AH: ENOENT when opening workspace files
 * from library in source-path-backed spaces (e.g., Google Drive symlinks).
 *
 * Bug: notification orphan detection checks BOTH workspace path and sourcePath,
 * but library:read-file only resolves through workspace path. When the workspace
 * symlink is broken but the file exists at sourcePath, notifications survive
 * orphan detection but the file viewer gets ENOENT.
 *
 * TDD step 1: These tests must FAIL (RED) before the fix is applied.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock infrastructure (matches pattern from rebelSystemFallback test)
// ---------------------------------------------------------------------------

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockGetSettings = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();
const mockScanSpaces = vi.fn();
const mockScanSpacesReadOnly = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
  updateSettingsAtomic: vi.fn(),
}));

vi.mock('../../tracking', () => ({
  mainTracking: {
    workArtifactCreated: vi.fn(),
  },
}));

vi.mock('../../services/systemSettingsSync', () => ({
  getSystemSettingsPath: () => '/mock/bundled/rebel-system',
}));

vi.mock('../../utils/systemUtils', async () => {
  const actual = await vi.importActual<typeof import('../../utils/systemUtils')>('../../utils/systemUtils');
  return {
    ...actual,
    resolveLibraryPath: vi.fn((target: string, coreDirectory: string) => {
      const root = path.resolve(coreDirectory);
      const resolved = path.resolve(root, target);
      return { root, resolved };
    }),
    tryConvertToWorkspacePath: vi.fn((p: string) => p),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...args: unknown[]) => mockStat(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    access: vi.fn(),
    cp: vi.fn(),
    rm: vi.fn(),
    lstat: vi.fn(),
  },
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    getPath: () => '/mock/app-data',
    getVersion: () => '1.0.0',
  }),
}));

vi.mock('@core/featureGating', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../utils/emfileRetry', () => ({
  // Match production: src/core/utils/emfileRetry.ts matches BOTH EMFILE and
  // ENFILE. The old mock only matched EMFILE, which hid the ENFILE mislabelling
  // bug caught by C5.12 review.
  isTooManyOpenFilesError: (err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EMFILE' || code === 'ENFILE';
  },
  withRetryOnEmfile: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../utils/cloudStorageUtils', () => ({
  detectCloudStorage: vi.fn().mockReturnValue(null),
}));

vi.mock('@core/utils/portablePath', () => ({
  toPortablePath: vi.fn((p: string) => p),
  relativePortablePath: vi.fn((p: string) => p),
}));

vi.mock('../../services/demoModeService', () => ({
  isDemoModeActive: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/fileTreeService', () => ({
  buildFileTree: vi.fn(),
  countLibraryItems: vi.fn(),
}));

vi.mock('../../services/spaceService', () => ({
  scanSpaces: (...args: unknown[]) => mockScanSpaces(...args),
  scanSpacesWithSideEffects: (...args: unknown[]) => mockScanSpaces(...args),
  scanSpacesReadOnly: (...args: unknown[]) => mockScanSpacesReadOnly(...args),
  scanSuggestedSpaces: vi.fn(),
  scanForFrontmatterWarnings: vi.fn(),
  createSpace: vi.fn(),
  initializeSpaceReadme: vi.fn(),
  removeSpace: vi.fn(),
  moveSpace: vi.fn(),
  renameSpace: vi.fn(),
  migrateSpacePathInSettings: vi.fn(),
  updateSpaceFrontmatter: vi.fn(),
  reconcileSpacesWithSettings: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  migrateLegacyAgentsMd: vi.fn(),
  resolveViaSpaceName: vi.fn().mockResolvedValue(null),
  invalidateSpaceScanCache: vi.fn(),
  registerSpaceScanCacheInvalidationListener: vi.fn(() => () => {}),
}));

vi.mock('../../services/skillsService', () => ({
  scanSkills: vi.fn(),
  getExampleMetas: vi.fn(),
}));

vi.mock('../../services/skillAttributionRepairService', () => ({
  repairSharedSkillAttributionFromScanResult: vi.fn(),
}));

vi.mock('../../services/skillUsageStore', () => ({
  getAllSkillUsage: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
}));

vi.mock('../../services/achievementsStore', () => ({
  markJourneyDayComplete: vi.fn(),
  getOnboardingJourney: vi.fn(),
}));

vi.mock('../../services/achievementsEvaluator', () => ({
  getCurrentJourneyDay: vi.fn(),
}));

vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock('../../services/sharedDriveHealthService', () => ({
  runSharedDriveHealthChecks: vi.fn(),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn(),
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

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    writeManagedSkillFile: vi.fn(),
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock('../../services/driveSkillHistoryService', () => ({
  driveSkillHistoryService: {
    listVersions: vi.fn(),
    getSnapshot: vi.fn(),
    restoreVersion: vi.fn(),
    forkSnapshotToChiefOfStaff: vi.fn(),
  },
}));

vi.mock('../../services/skillChangeNotificationService', () => ({
  skillChangeNotificationService: {
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock('front-matter', () => ({
  default: vi.fn((content: string) => ({ attributes: {}, body: content })),
}));

vi.mock('@core/skillQualityScore', () => ({
  computeSkillQualityScore: vi.fn().mockReturnValue({ overallScore: 50, breakdown: {} }),
}));

vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  normalizeModel: vi.fn((m: string) => m),
}));

vi.mock('@shared/utils/settingsUtils', () => ({
  normalizeSettings: vi.fn((s: unknown) => s),
}));

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const MOCK_WORKSPACE = '/mock/workspace';
const MOCK_SOURCE_PATH = '/mock/google-drive/Shared drives/Company/General';

// The space "General" lives at work/mindstone/General in the workspace
// but its actual data is at MOCK_SOURCE_PATH (Google Drive)
const SPACE_WORKSPACE_PATH = 'work/mindstone/General';

function makeEnoentError(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function makeFakeStats(isFile = true): import('fs').Stats {
  return {
    isFile: () => isFile,
    isDirectory: () => !isFile,
    // S4.1e: boundedWorkspaceFs.toWorkspaceStat() needs isSymbolicLink() + ctimeMs.
    isSymbolicLink: () => false,
    mtimeMs: 1234567890,
    ctimeMs: 1234567890,
    size: 4096,
  } as unknown as import('fs').Stats;
}

function makeMockSpaceInfo(overrides: Record<string, unknown> = {}) {
  return {
    name: 'General',
    path: SPACE_WORKSPACE_PATH,
    absolutePath: path.resolve(MOCK_WORKSPACE, SPACE_WORKSPACE_PATH),
    type: 'work' as const,
    isSymlink: true,
    hasReadme: true,
    sourcePath: MOCK_SOURCE_PATH,
    sharing: 'team',
    ...overrides,
  };
}

import { registerLibraryHandlers } from '../libraryHandlers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('library:read-file sourcePath fallback for symlinked spaces (REBEL-1AH)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({
      coreDirectory: MOCK_WORKSPACE,
      spaces: [{ name: 'General', path: SPACE_WORKSPACE_PATH }],
    });

    mockScanSpaces.mockResolvedValue([makeMockSpaceInfo()]);
    mockScanSpacesReadOnly.mockResolvedValue([makeMockSpaceInfo()]);

    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('precondition: workspace path differs from sourcePath (precondition)', () => {
    const workspacePath = path.resolve(MOCK_WORKSPACE, SPACE_WORKSPACE_PATH);
    expect(workspacePath).not.toBe(MOCK_SOURCE_PATH);
    expect(workspacePath).toBe(path.resolve('/mock/workspace/work/mindstone/General'));
  });

  it('should read from sourcePath when workspace symlink is broken (confirms bug)', async () => {
    // Simulate: workspace symlink broken, but file exists at Google Drive sourcePath
    const workspacePath = path.resolve(
      MOCK_WORKSPACE,
      'work/mindstone/General/skills/presentations/generate-gamma-presentation/SKILL.md'
    );
    const sourcePathFile = path.resolve(
      MOCK_SOURCE_PATH,
      'skills/presentations/generate-gamma-presentation/SKILL.md'
    );

    // fs.stat: workspace ENOENT (broken symlink), sourcePath succeeds
    mockStat.mockImplementation(async (p: string) => {
      if (p === workspacePath) throw makeEnoentError();
      if (p === sourcePathFile) return makeFakeStats();
      throw makeEnoentError();
    });

    mockReadFile.mockImplementation(async (p: string) => {
      if (p === sourcePathFile) return 'skill content from Google Drive';
      throw makeEnoentError();
    });

    const handler = registeredHandlers.get('library:read-file');
    expect(handler).toBeDefined();

    // This is the key test: should NOT throw ENOENT, should fall back to sourcePath
    const result: any = await handler!(
      {},
      'work/mindstone/General/skills/presentations/generate-gamma-presentation/SKILL.md'
    );

    expect(result.content).toBe('skill content from Google Drive');
  });

  it('should preserve original workspace-relative path in response when using sourcePath fallback', async () => {
    const target = 'work/mindstone/General/skills/my-skill/SKILL.md';
    const workspacePath = path.resolve(MOCK_WORKSPACE, target);
    const sourcePathFile = path.resolve(MOCK_SOURCE_PATH, 'skills/my-skill/SKILL.md');

    mockStat.mockImplementation(async (p: string) => {
      if (p === workspacePath) throw makeEnoentError();
      if (p === sourcePathFile) return makeFakeStats();
      throw makeEnoentError();
    });

    mockReadFile.mockImplementation(async (p: string) => {
      if (p === sourcePathFile) return 'fallback content';
      throw makeEnoentError();
    });

    const handler = registeredHandlers.get('library:read-file');
    const result: any = await handler!({}, target);

    // Response path should be the original target, not the sourcePath absolute
    expect(result.path).toBe(target);
    expect(result.content).toBe('fallback content');
  });

  it('should NOT fall back when file is missing from BOTH workspace and sourcePath', async () => {
    // File doesn't exist anywhere
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file');

    await expect(
      handler!({}, 'work/mindstone/General/skills/nonexistent/SKILL.md')
    ).rejects.toThrow('Unable to access the requested file.');
  });

  it('should NOT fall back for paths outside any sourcePath-backed space', async () => {
    // Path is in Chief-of-Staff (no sourcePath), not in General
    mockScanSpaces.mockResolvedValue([
      makeMockSpaceInfo(),
      {
        name: 'Chief-of-Staff',
        path: 'Chief-of-Staff',
        absolutePath: path.resolve(MOCK_WORKSPACE, 'Chief-of-Staff'),
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
        // No sourcePath — local space
      },
    ]);

    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file');

    await expect(
      handler!({}, 'Chief-of-Staff/skills/local-skill/SKILL.md')
    ).rejects.toThrow('Unable to access the requested file.');
  });

  it('should reject path traversal via sourcePath fallback', async () => {
    // A crafted path that tries to escape the source root
    // The space path matches, but the inner path has traversal
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file');

    // This path has traversal inside the space-relative portion
    await expect(
      handler!({}, 'work/mindstone/General/skills/../../../etc/passwd')
    ).rejects.toThrow('Unable to access the requested file.');
  });

  it('should not call scanSpaces on happy path (no performance regression)', async () => {
    const target = 'work/mindstone/General/skills/good-skill/SKILL.md';
    mockStat.mockResolvedValue(makeFakeStats());
    mockReadFile.mockResolvedValue('content');

    const handler = registeredHandlers.get('library:read-file');
    await handler!({}, target);

    // scanSpacesReadOnly should NOT be called when the file is found at the workspace path
    expect(mockScanSpaces).not.toHaveBeenCalled();
    expect(mockScanSpacesReadOnly).not.toHaveBeenCalled();
  });

  it('should read normally (no fallback) when workspace symlink is working', async () => {
    const target = 'work/mindstone/General/skills/working-skill/SKILL.md';
    const workspacePath = path.resolve(MOCK_WORKSPACE, target);

    mockStat.mockResolvedValue(makeFakeStats());
    mockReadFile.mockResolvedValue('content via workspace symlink');

    const handler = registeredHandlers.get('library:read-file');
    const result: any = await handler!({}, target);

    expect(result.content).toBe('content via workspace symlink');
    // Should have only called stat on the workspace path, NOT scanned spaces
    expect(mockScanSpaces).not.toHaveBeenCalled();
    expect(mockScanSpacesReadOnly).not.toHaveBeenCalled();
  });
});

describe('library:read-file-base64 sourcePath fallback for symlinked spaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({
      coreDirectory: MOCK_WORKSPACE,
      spaces: [{ name: 'General', path: SPACE_WORKSPACE_PATH }],
    });

    mockScanSpaces.mockResolvedValue([makeMockSpaceInfo()]);
    mockScanSpacesReadOnly.mockResolvedValue([makeMockSpaceInfo()]);

    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('should read base64 from sourcePath when workspace symlink is broken', async () => {
    const target = 'work/mindstone/General/skills/my-skill/image.png';
    const workspacePath = path.resolve(MOCK_WORKSPACE, target);
    const sourcePathFile = path.resolve(MOCK_SOURCE_PATH, 'skills/my-skill/image.png');

    mockStat.mockImplementation(async (p: string) => {
      if (p === workspacePath) throw makeEnoentError();
      if (p === sourcePathFile) return makeFakeStats();
      throw makeEnoentError();
    });

    mockReadFile.mockImplementation(async (p: string) => {
      if (p === sourcePathFile) return Buffer.from('image data from drive');
      throw makeEnoentError();
    });

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    const result = await handler!({}, target);
    expect(result).toEqual({
      base64: Buffer.from('image data from drive').toString('base64'),
      mtimeMs: 1234567890,
      size: 4096,
    });
  });

  it('should NOT fall back when file missing from both roots (base64)', async () => {
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file-base64');

    await expect(
      handler!({}, 'work/mindstone/General/skills/nonexistent/image.png')
    ).rejects.toThrow('Unable to read the requested file.');
  });
});

// ---------------------------------------------------------------------------
// C5.12 — errno preservation in error messages
// Text handler (library:read-file) already preserves errno. This block
// closes the symmetric gap in library:read-file-base64 and the text handler's
// EMFILE branch (found via batch-1 review). The core guarantee:
// "Unable to read/access the requested file. (<CODE>)" — the code is always
// the real errno, never hard-coded (isTooManyOpenFilesError matches both
// EMFILE AND ENFILE).
// ---------------------------------------------------------------------------

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('C5.12 — errno preservation in library read-file error messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({
      coreDirectory: MOCK_WORKSPACE,
      spaces: [],
    });

    // No sourcePath-backed spaces: fallback short-circuits, original error
    // propagates to the outer catch.
    mockScanSpaces.mockResolvedValue([]);
    mockScanSpacesReadOnly.mockResolvedValue([]);

    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  describe('library:read-file-base64', () => {
    it('preserves ENOENT in thrown message', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const handler = registeredHandlers.get('library:read-file-base64');
      await expect(handler!({}, 'some/file.png')).rejects.toThrow(
        'Unable to read the requested file. (ENOENT)',
      );
    });

    it('preserves EACCES in thrown message', async () => {
      mockStat.mockRejectedValue(makeErrnoError('EACCES'));

      const handler = registeredHandlers.get('library:read-file-base64');
      await expect(handler!({}, 'some/file.png')).rejects.toThrow(
        'Unable to read the requested file. (EACCES)',
      );
    });

    it('preserves EMFILE in thrown message (not hard-coded)', async () => {
      mockStat.mockRejectedValue(makeErrnoError('EMFILE'));

      const handler = registeredHandlers.get('library:read-file-base64');
      await expect(handler!({}, 'some/file.png')).rejects.toThrow(
        'Unable to read the requested file. (EMFILE)',
      );
    });

    it('preserves ENFILE in thrown message (regression: was mislabelled as EMFILE before fix)', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENFILE'));

      const handler = registeredHandlers.get('library:read-file-base64');
      // This is the key assertion: ENFILE must NOT be reported as EMFILE.
      const promise = handler!({}, 'some/file.png');
      await expect(promise).rejects.toThrow(
        'Unable to read the requested file. (ENFILE)',
      );
      await expect(promise).rejects.not.toThrow(/\(EMFILE\)/);
    });
  });

  describe('library:read-file (text handler)', () => {
    it('preserves ENOENT in thrown message (pre-existing behaviour, regression guard)', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const handler = registeredHandlers.get('library:read-file');
      await expect(handler!({}, 'some/file.md')).rejects.toThrow(
        'Unable to access the requested file. (ENOENT)',
      );
    });

    it('preserves EMFILE in thrown message (C5.12 symmetric fix)', async () => {
      // When stat succeeds but readFile hits EMFILE, withRetryOnEmfile gives
      // up and the outer catch needs to report the real code. The existing
      // inner readFile catch (line 970-975) throws `Unable to read the
      // selected file. (EMFILE)` with errno. The text handler outer catch
      // handles EMFILE thrown from elsewhere (e.g., from `stat` if it ever
      // propagates without the inner catch owning it).
      mockStat.mockResolvedValue(makeFakeStats());
      mockReadFile.mockRejectedValue(makeErrnoError('EMFILE'));

      const handler = registeredHandlers.get('library:read-file');
      await expect(handler!({}, 'some/file.md')).rejects.toThrow(
        'Unable to read the selected file. (EMFILE)',
      );
    });

    it('preserves ENFILE in thrown message (regression: was mislabelled before)', async () => {
      mockStat.mockResolvedValue(makeFakeStats());
      mockReadFile.mockRejectedValue(makeErrnoError('ENFILE'));

      const handler = registeredHandlers.get('library:read-file');
      const promise = handler!({}, 'some/file.md');
      await expect(promise).rejects.toThrow(
        'Unable to read the selected file. (ENFILE)',
      );
    });
  });
});
