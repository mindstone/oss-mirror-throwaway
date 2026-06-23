/**
 * Unit tests for the library:stat-file IPC handler.
 *
 * Validates the contract the renderer relies on for the
 * MessageMarkdown.tsx image-freshness probe (see
 * docs-private/investigations/260519_stale_image_cache_after_agent_overwrite.md):
 *
 *   - Existing files resolve to { exists: true, mtimeMs: <n>, size: <n> }.
 *   - Non-existent files resolve to { exists: false, mtimeMs: null, size: null }
 *     (the handler does NOT throw on ENOENT — the renderer treats missing
 *     as "leave cache alone").
 *   - Workspace-escape still throws with the canonical
 *     "outside the workspace directory" fragment so the renderer's
 *     classifier path (classifyError → 'workspace-escape') keeps working.
 *   - Source-path fallback fires for broken workspace symlinks to external
 *     storage, mirroring library:read-file-base64's salvage behaviour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

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

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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

const MOCK_WORKSPACE = '/mock/workspace';
const MOCK_SOURCE_PATH = '/mock/google-drive/Shared drives/Company/General';
const SPACE_WORKSPACE_PATH = 'work/mindstone/General';

const WORKSPACE_ESCAPE_ERROR_FRAGMENT = 'outside the workspace directory';

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeFakeStats(overrides: { isFile?: boolean; mtimeMs?: number; size?: number } = {}): import('fs').Stats {
  const isFile = overrides.isFile ?? true;
  return {
    isFile: () => isFile,
    isDirectory: () => !isFile,
    // S4.1e: reads route through boundedWorkspaceFs, whose toWorkspaceStat() calls
    // isSymbolicLink() + reads ctimeMs — the fake Stats must provide them.
    isSymbolicLink: () => false,
    mtimeMs: overrides.mtimeMs ?? 1700000000000,
    ctimeMs: overrides.mtimeMs ?? 1700000000000,
    size: overrides.size ?? 4096,
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

describe('library:stat-file handler', () => {
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

  it('T-STAT-MAIN-1: existing file returns { exists: true, mtimeMs, size }', async () => {
    mockStat.mockResolvedValue(makeFakeStats({ mtimeMs: 1234567890, size: 8192 }));

    const handler = registeredHandlers.get('library:stat-file');
    expect(handler).toBeDefined();

    const result = await handler!({}, 'some/image.png');

    expect(result).toEqual({
      exists: true,
      mtimeMs: 1234567890,
      size: 8192,
    });
  });

  it('T-STAT-MAIN-2: non-existent file (ENOENT) resolves to { exists: false, mtimeMs: null, size: null } without throwing', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const handler = registeredHandlers.get('library:stat-file');
    expect(handler).toBeDefined();

    const result = await handler!({}, 'missing/image.png');

    expect(result).toEqual({
      exists: false,
      mtimeMs: null,
      size: null,
    });
  });

  it('T-STAT-MAIN-3: workspace-escape throws with the canonical "outside the workspace directory" fragment', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const handler = registeredHandlers.get('library:stat-file');
    expect(handler).toBeDefined();

    // Use the basePath branch so the inner `path.resolve(baseDir, rawPath)`
    // escapes the workspace root without going through resolveLibraryPath's
    // own boundary check. Mirrors T-WS-CONTRACT-1 in libraryHandlers.errorMessageContract.test.ts.
    await expect(
      handler!({}, {
        target: '../../../foo.png',
        basePath: 'space/doc.md',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(WORKSPACE_ESCAPE_ERROR_FRAGMENT),
    });
  });

  it('T-STAT-MAIN-3b: resolveLibraryPath-branch workspace-escape also preserves the canonical fragment', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const handler = registeredHandlers.get('library:stat-file');
    expect(handler).toBeDefined();

    // Without a basePath, the path goes through resolveLibraryPath which
    // throws with a different canonical string; both must include the
    // shared fragment the renderer classifier matches on.
    await expect(handler!({}, '../../../escape.png')).rejects.toMatchObject({
      message: expect.stringContaining(WORKSPACE_ESCAPE_ERROR_FRAGMENT),
    });
  });

  it('T-STAT-MAIN-4: source-path fallback resolves a broken workspace symlink via the space sourcePath', async () => {
    const target = `${SPACE_WORKSPACE_PATH}/skills/my-skill/image.png`;
    const workspacePath = path.resolve(MOCK_WORKSPACE, target);
    const sourcePathFile = path.resolve(MOCK_SOURCE_PATH, 'skills/my-skill/image.png');

    mockStat.mockImplementation(async (p: string) => {
      if (p === workspacePath) throw makeErrnoError('ENOENT');
      if (p === sourcePathFile) return makeFakeStats({ mtimeMs: 9999, size: 5678 });
      throw makeErrnoError('ENOENT');
    });

    const handler = registeredHandlers.get('library:stat-file');
    expect(handler).toBeDefined();

    const result = await handler!({}, target);

    expect(result).toEqual({
      exists: true,
      mtimeMs: 9999,
      size: 5678,
    });
  });
});
