 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

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

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

import { registerLibraryHandlers } from '../libraryHandlers';

describe('library handler workspace-escape error message contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    mockGetSettings.mockReturnValue({ coreDirectory: MOCK_WORKSPACE });
    registerLibraryHandlers({
      getSettings: mockGetSettings,
      getSettingsStore: () => ({ store: mockGetSettings() }),
    });
  });

  it('T-WS-CONTRACT-1: basePath branch preserves "Resolved path is outside the workspace directory."', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const handler = registeredHandlers.get('library:read-file-base64');
    expect(handler).toBeDefined();

    await expect(
      handler!({}, {
        target: '../../../foo.png',
        basePath: 'space/doc.md',
      }),
    ).rejects.toMatchObject({
      message: 'Resolved path is outside the workspace directory.',
    });
  });

  it('T-WS-CONTRACT-2: resolveLibraryPath branch preserves "Access to paths outside the workspace directory is not permitted."', async () => {
    mockStat.mockRejectedValue(makeErrnoError('ENOENT'));

    const handler = registeredHandlers.get('library:read-file');
    expect(handler).toBeDefined();

    await expect(handler!({}, '../../../foo.md')).rejects.toMatchObject({
      message: 'Access to paths outside the workspace directory is not permitted.',
    });
  });
});
