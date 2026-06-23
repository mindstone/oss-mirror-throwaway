 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockGetSettings = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerDebug = vi.fn();

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

vi.mock('@core/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
  },
  // libraryHandlers transitively imports cloudSpaceContainment (Stage 5
  // isUnderCloudSpace), which uses a scoped logger.
  createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../services/systemSettingsSync', () => ({
  getSystemSettingsPath: () => '/mock/bundled/rebel-system',
}));

vi.mock('../../utils/systemUtils', async () => {
  const actual = await vi.importActual<typeof import('../../utils/systemUtils')>('../../utils/systemUtils');
  return {
    ...actual,
    resolveLibraryPath: vi.fn((target: string, coreDirectory: string) => {
      const trimmed = target.trim();
      const root = path.resolve(coreDirectory);
      const resolved = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(root, trimmed);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error('Access to paths outside the workspace directory is not permitted.');
      }
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
  scanSpaces: vi.fn().mockResolvedValue([]),
  scanSpacesWithSideEffects: vi.fn().mockResolvedValue([]),
  scanSpacesReadOnly: vi.fn().mockResolvedValue([]),
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

const MOCK_WORKSPACE = '/mock/workspace';
const MOCK_BUNDLED = '/mock/bundled/rebel-system';

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated error`) as NodeJS.ErrnoException;
  err.code = code;
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

function getSalvageInfoPayloads(): Array<Record<string, unknown>> {
  return mockLoggerInfo.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is Record<string, unknown> => (
      !!payload
      && typeof payload === 'object'
      && (payload as Record<string, unknown>).source === 'workspace-escape-salvage'
    ));
}

import { registerLibraryHandlers, resolveWorkspaceEscapeSalvage } from '../libraryHandlers';

describe('resolveWorkspaceEscapeSalvage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({ coreDirectory: MOCK_WORKSPACE });
    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('T-WS-MAIN-1: returns salvaged path for ../../../foo.txt when file exists', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));

    const result = await resolveWorkspaceEscapeSalvage(
      '../../../foo.txt',
      MOCK_WORKSPACE,
      'library:read-file',
      async (operation) => operation(),
    );

    expect(result).toEqual({
      salvagedPath: path.resolve(MOCK_WORKSPACE, 'foo.txt'),
      salvagedTail: 'foo.txt',
    });
  });

  it('T-WS-MAIN-2: returns null for missing salvaged file (ENOENT)', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const result = await resolveWorkspaceEscapeSalvage(
      '../../../foo.txt',
      MOCK_WORKSPACE,
      'library:read-file',
      async (operation) => operation(),
    );

    expect(result).toBeNull();
  });

  it('T-WS-MAIN-3: returns null when tail still escapes after strip', async () => {
    const result = await resolveWorkspaceEscapeSalvage(
      '../../foo/../../etc/passwd',
      MOCK_WORKSPACE,
      'library:read-file',
      async (operation) => operation(),
    );

    expect(result).toBeNull();
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('T-WS-MAIN-4: returns null for scheme-prefixed input', async () => {
    const result = await resolveWorkspaceEscapeSalvage(
      'https://evil.com/foo.png',
      MOCK_WORKSPACE,
      'library:read-file-base64',
      async (operation) => operation(),
    );

    expect(result).toBeNull();
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('T-WS-MAIN-4b: rejects Windows device/UNC/drive/NUL path shapes helper-locally', async () => {
    const dangerousTargets = [
      '\\\\?\\C:\\foo.png',
      '\\\\.\\PhysicalDrive0',
      '\\\\server\\share\\foo.png',
      'C:foo.png',
      'foo\0bar.png',
    ];

    for (const target of dangerousTargets) {
      const result = await resolveWorkspaceEscapeSalvage(
        target,
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );
      expect(result).toBeNull();
    }
  });

  describe('T-WS-MAIN-4c — post-strip dangerous-form rejection', () => {
    it('T-WS-MAIN-4c-1: returns null for ../../../https://evil.com/foo.png', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        '../../../https://evil.com/foo.png',
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-2: returns null for ../file:///etc/passwd', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        '../file:///etc/passwd',
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-3: returns null for ../data:image/png;base64,xxx', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        '../data:image/png;base64,xxx',
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-4: returns null for ../C:foo.png', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        '../C:foo.png',
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-5: returns null for ../../C:/Windows/System32/foo.exe', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        '../../C:/Windows/System32/foo.exe',
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-6: returns null for ../\\\\?\\C:\\foo.png', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        String.raw`../\\?\C:\foo.png`,
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-7: returns null for ../foo\\u0000bar.png', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        '../foo\u0000bar.png',
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });

    it('T-WS-MAIN-4c-8: returns null for ../../\\\\server\\share\\foo.png', async () => {
      mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

      const result = await resolveWorkspaceEscapeSalvage(
        String.raw`../../\\server\share\foo.png`,
        MOCK_WORKSPACE,
        'library:read-file-base64',
        async (operation) => operation(),
      );

      expect(result).toBeNull();
      expect(getSalvageInfoPayloads()).toHaveLength(0);
    });
  });

  it('T-WS-MAIN-5: returns null when salvaged candidate is not a file', async () => {
    mockStat.mockResolvedValue(makeFakeStats(false));

    const result = await resolveWorkspaceEscapeSalvage(
      '../../../foo',
      MOCK_WORKSPACE,
      'library:read-file',
      async (operation) => operation(),
    );

    expect(result).toBeNull();
  });

  it('T-WS-MAIN-6: returns null when path has no leading parent segments', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));

    const result = await resolveWorkspaceEscapeSalvage(
      'foo/bar.png',
      MOCK_WORKSPACE,
      'library:read-file-base64',
      async (operation) => operation(),
    );

    expect(result).toBeNull();
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('T-WS-MAIN-7: returns null for empty tails (../ and ../../)', async () => {
    const resultOne = await resolveWorkspaceEscapeSalvage(
      '../',
      MOCK_WORKSPACE,
      'library:read-file',
      async (operation) => operation(),
    );
    const resultTwo = await resolveWorkspaceEscapeSalvage(
      '../../',
      MOCK_WORKSPACE,
      'library:read-file',
      async (operation) => operation(),
    );

    expect(resultOne).toBeNull();
    expect(resultTwo).toBeNull();
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('T-WS-MAIN-12: normalizes backslashes before stripping leading parents', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));

    const result = await resolveWorkspaceEscapeSalvage(
      '..\\..\\..\\foo.txt',
      MOCK_WORKSPACE,
      'library:read-file-base64',
      async (operation) => operation(),
    );

    expect(result).toEqual({
      salvagedPath: path.resolve(MOCK_WORKSPACE, 'foo.txt'),
      salvagedTail: 'foo.txt',
    });
  });

  it('T-WS-MAIN-14: rethrows EMFILE and does not silently return null', async () => {
    let slotActive = false;
    const runWithSlot = async <T>(operation: () => Promise<T>): Promise<T> => {
      slotActive = true;
      try {
        return await operation();
      } finally {
        slotActive = false;
      }
    };

    mockStat.mockImplementation(async () => {
      expect(slotActive).toBe(true);
      throw makeErrnoError('EMFILE');
    });

    await expect(
      resolveWorkspaceEscapeSalvage(
        '../../../foo.txt',
        MOCK_WORKSPACE,
        'library:read-file',
        runWithSlot,
      ),
    ).rejects.toMatchObject({ code: 'EMFILE' });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: 'library:read-file',
        source: 'workspace-escape-salvage',
        code: 'EMFILE',
      }),
      'workspace-escape salvage stat failed unexpectedly',
    );
  });
});

describe('workspace-escape salvage handler wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({ coreDirectory: MOCK_WORKSPACE });
    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('T-WS-MAIN-8: library:read-file salvages ../../../foo.md and returns contents', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));
    mockReadFile.mockResolvedValue('salvaged markdown');

    const handler = registeredHandlers.get('library:read-file');
    expect(handler).toBeDefined();

    const result: any = await handler!({}, '../../../foo.md');

    expect(result.content).toBe('salvaged markdown');
    expect(result.path).toBe('../../../foo.md');
    expect(getSalvageInfoPayloads()).toContainEqual({
      handler: 'library:read-file',
      leadingParentCount: 3,
      tailDepth: 1,
      ext: '.md',
      source: 'workspace-escape-salvage',
    });
  });

  it('T-WS-MAIN-9: library:read-file-base64 no-basePath branch salvages reported offending path', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));
    mockReadFile.mockResolvedValue(Buffer.from('image-bytes'));

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    const result = await handler!(
      {},
      '../../../../../Chief-of-Staff/generated-images/foo.png',
    );

    expect(result).toEqual({
      base64: Buffer.from('image-bytes').toString('base64'),
      mtimeMs: 1234567890,
      size: 4096,
    });
    expect(getSalvageInfoPayloads()).toContainEqual({
      handler: 'library:read-file-base64',
      leadingParentCount: 5,
      tailDepth: 3,
      ext: '.png',
      source: 'workspace-escape-salvage',
    });
  });

  it('T-WS-MAIN-10: library:read-file-base64 basePath branch salvages using raw target', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));
    mockReadFile.mockResolvedValue(Buffer.from('base-path-branch-image'));

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    const result = await handler!({}, {
      target: '../../../foo.png',
      basePath: 'space/doc.md',
    });

    expect(result).toEqual({
      base64: Buffer.from('base-path-branch-image').toString('base64'),
      mtimeMs: 1234567890,
      size: 4096,
    });
    expect(getSalvageInfoPayloads()).toContainEqual({
      handler: 'library:read-file-base64',
      leadingParentCount: 3,
      tailDepth: 1,
      ext: '.png',
      source: 'workspace-escape-salvage',
    });
  });

  it('T-WS-MAIN-11: write handlers remain untouched (no salvage on library:write-file)', async () => {
    const handler = registeredHandlers.get('library:write-file');
    expect(handler).toBeDefined();

    await expect(
      handler!({}, { path: '../../../foo.md', content: 'write attempt' }),
    ).rejects.toThrow('Access to paths outside the workspace directory is not permitted.');

    expect(getSalvageInfoPayloads()).toHaveLength(0);
    expect(registeredHandlers.has('library:write-base64')).toBe(false);
    expect(registeredHandlers.has('library:write-file-base64')).toBe(false);
  });

  it('T-WS-MAIN-13: ../../../rebel-system/foo returns null salvage and does not bypass rebel fallback', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    await expect(handler!({}, '../../../rebel-system/foo')).rejects.toThrow(
      'Access to paths outside the workspace directory is not permitted.',
    );

    const statPaths = mockStat.mock.calls.map((call) => call[0] as string);
    expect(statPaths).not.toContain(path.resolve(MOCK_BUNDLED, 'foo'));
  });

  it('T-WS-MAIN-15: salvage success logs shape data only (no raw path values)', async () => {
    mockStat.mockResolvedValue(makeFakeStats(true));
    mockReadFile.mockResolvedValue(Buffer.from('image-bytes'));

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    await handler!({}, '../../../../../Chief-of-Staff/generated-images/foo.png');

    const payload = getSalvageInfoPayloads().find(
      (entry) => entry.handler === 'library:read-file-base64',
    );
    expect(payload).toEqual({
      handler: 'library:read-file-base64',
      leadingParentCount: 5,
      tailDepth: 3,
      ext: '.png',
      source: 'workspace-escape-salvage',
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\/mock\/workspace/);
    expect(serialized).not.toMatch(/Chief-of-Staff/);
    expect(serialized).not.toMatch(/generated-images/);
    expect(serialized).not.toMatch(/foo\.png/);
  });
});
