/**
 * Unit tests for rebel-system bundled-path fallback in library:read-file and
 * library:read-file-base64 IPC handlers.
 *
 * Verifies that when the workspace symlink for rebel-system is broken/missing,
 * the handlers transparently fall back to the bundled rebel-system directory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockGetSettings = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockMkdir = vi.fn();

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

// Mock systemSettingsSync — returns the bundled rebel-system path
vi.mock('../../services/systemSettingsSync', () => ({
  getSystemSettingsPath: () => '/mock/bundled/rebel-system',
}));

// Mock resolveLibraryPath — returns workspace path
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
  isTooManyOpenFilesError: (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'EMFILE',
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
  scanSpaces: vi.fn(),
  scanSpacesWithSideEffects: vi.fn(),
  // Stage 5: libraryHandlers calls scanSpacesReadOnly in the read-path
  // fallback. Return an empty preload; resolveViaSpaceName mock resolves to
  // null, preserving the pre-Stage-5 failure-path semantics.
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MOCK_WORKSPACE = '/mock/workspace';
const MOCK_BUNDLED = '/mock/bundled/rebel-system';

function makeEnoentError(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function makeEaccesError(): NodeJS.ErrnoException {
  const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
  err.code = 'EACCES';
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

import { registerLibraryHandlers, resolveRebelSystemFallback } from '../libraryHandlers';

describe('resolveRebelSystemFallback', () => {
  it('returns fallback path for rebel-system/ prefixed target', () => {
    const result = resolveRebelSystemFallback('rebel-system/skills/foo/SKILL.md');
    expect(result).not.toBeNull();
    expect(result!.fallbackPath).toBe(path.resolve(MOCK_BUNDLED, 'skills/foo/SKILL.md'));
    expect(result!.systemRoot).toBe(MOCK_BUNDLED);
  });

  it('returns null for non-rebel-system target', () => {
    const result = resolveRebelSystemFallback('some-other-dir/file.md');
    expect(result).toBeNull();
  });

  it('rejects traversal via rebel-system/../../../etc/passwd', () => {
    const result = resolveRebelSystemFallback('rebel-system/../../../etc/passwd');
    expect(result).toBeNull();
  });

  it('rejects double-slash traversal via rebel-system//etc/passwd', () => {
    // path.resolve handles //etc/passwd as /etc/passwd (absolute) on Unix
    const result = resolveRebelSystemFallback('rebel-system//etc/passwd');
    // On macOS/Linux, path.resolve('/mock/bundled/rebel-system', '/etc/passwd') → '/etc/passwd'
    // which escapes the systemRoot → isPathInsideLexical returns false
    expect(result).toBeNull();
  });

  it('rejects Windows-style traversal via rebel-system/C:\\secret.txt', () => {
    const result = resolveRebelSystemFallback('rebel-system/C:\\secret.txt');
    // After backslash normalization: 'rebel-system/C:/secret.txt'
    // path.resolve may treat C:/secret.txt as absolute on Windows
    // On macOS it resolves to '/mock/bundled/rebel-system/C:/secret.txt' (safe)
    // Either way, if it escapes systemRoot, it should be rejected
    if (process.platform === 'win32') {
      expect(result).toBeNull();
    } else {
      // On macOS/Linux, the C: is treated as a directory name, stays inside root
      expect(result).not.toBeNull();
    }
  });
});

describe('library:read-file rebel-system fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({
      coreDirectory: MOCK_WORKSPACE,
    });

    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('reads from workspace when path exists (no fallback)', async () => {
    const workspacePath = path.resolve(MOCK_WORKSPACE, 'rebel-system/skills/foo/SKILL.md');
    mockStat.mockResolvedValue(makeFakeStats());
    mockReadFile.mockResolvedValue('workspace content');

    const handler = registeredHandlers.get('library:read-file');
    expect(handler).toBeDefined();

    const result: any = await handler!({}, 'rebel-system/skills/foo/SKILL.md');

    // Should read from workspace, not bundled
    expect(mockStat).toHaveBeenCalledWith(workspacePath);
    expect(result.content).toBe('workspace content');
    expect(result.path).toBe(workspacePath);
  });

  it('falls back to bundled path when workspace path ENOENT', async () => {
    const workspacePath = path.resolve(MOCK_WORKSPACE, 'rebel-system/skills/foo/SKILL.md');
    const bundledPath = path.resolve(MOCK_BUNDLED, 'skills/foo/SKILL.md');

    // Pre-flight stat: workspace ENOENT
    // Then stat inside retry block: bundled succeeds
    mockStat
      .mockRejectedValueOnce(makeEnoentError()) // pre-flight: workspace ENOENT
      .mockResolvedValue(makeFakeStats());       // retry block: bundled path succeeds

    mockReadFile.mockResolvedValue('bundled content');

    const handler = registeredHandlers.get('library:read-file');
    const result: any = await handler!({}, 'rebel-system/skills/foo/SKILL.md');

    // Should have tried workspace first, then fallen back to bundled
    expect(mockStat).toHaveBeenCalledWith(workspacePath);
    expect(mockStat).toHaveBeenCalledWith(bundledPath);
    expect(result.content).toBe('bundled content');
    // Response path should be the original target, not the bundled absolute path
    expect(result.path).toBe('rebel-system/skills/foo/SKILL.md');
  });

  it('does NOT fall back for non-rebel-system paths (normal ENOENT)', async () => {
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file');

    await expect(handler!({}, 'some-other-dir/file.md')).rejects.toThrow(
      'Unable to access the requested file.'
    );

    // Should never attempt the bundled path
    const bundledPath = path.resolve(MOCK_BUNDLED, 'some-other-dir/file.md');
    const statCalls = mockStat.mock.calls.map((c: unknown[]) => c[0]);
    expect(statCalls).not.toContain(bundledPath);
  });

  it('does NOT fall back for non-ENOENT errors (EACCES)', async () => {
    const workspacePath = path.resolve(MOCK_WORKSPACE, 'rebel-system/skills/foo/SKILL.md');

    // Pre-flight stat: EACCES (not ENOENT)
    mockStat.mockRejectedValue(makeEaccesError());

    const handler = registeredHandlers.get('library:read-file');

    await expect(handler!({}, 'rebel-system/skills/foo/SKILL.md')).rejects.toThrow(
      'Unable to access the requested file.'
    );

    // Should have tried workspace only, no bundled path attempt
    expect(mockStat).toHaveBeenCalledWith(workspacePath);
    const bundledPath = path.resolve(MOCK_BUNDLED, 'skills/foo/SKILL.md');
    const statCalls = mockStat.mock.calls.map((c: unknown[]) => c[0]);
    expect(statCalls).not.toContain(bundledPath);
  });

  it('errors when bundled path also does not exist', async () => {
    // Pre-flight: workspace ENOENT → swap to bundled
    // Retry block: bundled also ENOENT
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file');

    await expect(handler!({}, 'rebel-system/nonexistent.md')).rejects.toThrow(
      'Unable to access the requested file.'
    );
  });

  it('rejects traversal attack via rebel-system/../../../etc/passwd', async () => {
    // resolveRebelSystemFallback returns null for traversal → no fallback
    // resolveLibraryPath will resolve to workspace path, stat fails
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file');

    await expect(handler!({}, 'rebel-system/../../../etc/passwd')).rejects.toThrow(
      'Unable to access the requested file.'
    );

    // Should NOT attempt bundled fallback for traversal
    const statCalls = mockStat.mock.calls.map((c: unknown[]) => c[0] as string);
    const anyBundledCall = statCalls.some((p) => p.startsWith(MOCK_BUNDLED));
    expect(anyBundledCall).toBe(false);
  });
});

describe('library:read-file-base64 rebel-system fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({
      coreDirectory: MOCK_WORKSPACE,
    });

    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('reads from workspace when path exists (no fallback)', async () => {
    const workspacePath = path.resolve(MOCK_WORKSPACE, 'rebel-system/skills/foo/image.png');
    mockStat.mockResolvedValue(makeFakeStats());
    mockReadFile.mockResolvedValue(Buffer.from('image data'));

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    const result = await handler!({}, 'rebel-system/skills/foo/image.png');

    expect(mockStat).toHaveBeenCalledWith(workspacePath);
    expect(result).toEqual({
      base64: Buffer.from('image data').toString('base64'),
      mtimeMs: 1234567890,
      size: 4096,
    });
  });

  it('falls back to bundled path when workspace path ENOENT', async () => {
    const workspacePath = path.resolve(MOCK_WORKSPACE, 'rebel-system/skills/foo/image.png');
    const bundledPath = path.resolve(MOCK_BUNDLED, 'skills/foo/image.png');

    mockStat
      .mockRejectedValueOnce(makeEnoentError()) // pre-flight: workspace ENOENT
      .mockResolvedValue(makeFakeStats());       // retry block: bundled path succeeds

    mockReadFile.mockResolvedValue(Buffer.from('bundled image'));

    const handler = registeredHandlers.get('library:read-file-base64');
    const result = await handler!({}, 'rebel-system/skills/foo/image.png');

    expect(mockStat).toHaveBeenCalledWith(workspacePath);
    expect(mockStat).toHaveBeenCalledWith(bundledPath);
    expect(result).toEqual({
      base64: Buffer.from('bundled image').toString('base64'),
      mtimeMs: 1234567890,
      size: 4096,
    });
  });

  it('handles basePath object form with rebel-system fallback', async () => {
    const workspacePath = path.resolve(
      path.dirname(path.resolve(MOCK_WORKSPACE, 'rebel-system/skills/foo/doc.md')),
      'image.png'
    );
    const bundledPath = path.resolve(MOCK_BUNDLED, 'skills/foo/image.png');

    mockStat
      .mockRejectedValueOnce(makeEnoentError()) // pre-flight: workspace ENOENT
      .mockResolvedValue(makeFakeStats());       // retry block: bundled path succeeds

    mockReadFile.mockResolvedValue(Buffer.from('bundled image'));

    const handler = registeredHandlers.get('library:read-file-base64');
    const result = await handler!({}, {
      target: 'image.png',
      basePath: 'rebel-system/skills/foo/doc.md',
    });

    expect(mockStat).toHaveBeenCalledWith(workspacePath);
    expect(mockStat).toHaveBeenCalledWith(bundledPath);
    expect(result).toEqual({
      base64: Buffer.from('bundled image').toString('base64'),
      mtimeMs: 1234567890,
      size: 4096,
    });
  });

  it('does NOT fall back for non-ENOENT errors', async () => {
    mockStat.mockRejectedValue(makeEaccesError());

    const handler = registeredHandlers.get('library:read-file-base64');

    await expect(handler!({}, 'rebel-system/skills/foo/image.png')).rejects.toThrow(
      'Unable to read the requested file.'
    );

    const bundledPath = path.resolve(MOCK_BUNDLED, 'skills/foo/image.png');
    const statCalls = mockStat.mock.calls.map((c: unknown[]) => c[0]);
    expect(statCalls).not.toContain(bundledPath);
  });

  it('rejects basePath + traversal combo (relative target escaping rebel-system)', async () => {
    mockStat.mockRejectedValue(makeEnoentError());

    const handler = registeredHandlers.get('library:read-file-base64');

    await expect(handler!({}, {
      target: '../../../etc/passwd',
      basePath: 'rebel-system/skills/foo/doc.md',
    })).rejects.toThrow();

    // effectiveTarget = 'rebel-system/skills/foo/../../../etc/passwd'
    // After path.resolve, this escapes systemRoot → isPathInsideLexical returns false
    // So no bundled fallback should be attempted
    const statCalls = mockStat.mock.calls.map((c: unknown[]) => c[0] as string);
    const anyBundledCall = statCalls.some((p) => p.startsWith(MOCK_BUNDLED));
    expect(anyBundledCall).toBe(false);
  });
});
