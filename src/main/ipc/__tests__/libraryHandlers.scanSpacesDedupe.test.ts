import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();

const mockGetSettings = vi.fn();
const mockScanSpacesWithSideEffects = vi.fn();
const mockScanSpacesReadOnly = vi.fn();
const mockScanForFrontmatterWarnings = vi.fn();
const mockReconcileSpacesWithSettings = vi.fn();
const mockUpdateSettingsAtomic = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
  updateSettingsAtomic: (...args: unknown[]) => mockUpdateSettingsAtomic(...args),
}));

vi.mock('../../tracking', () => ({
  mainTracking: {
    workArtifactCreated: vi.fn(),
    skillCreated: vi.fn(),
  },
}));

vi.mock('@core/logger', async () => {
  const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

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
    stat: vi.fn(),
    readFile: vi.fn(),
    mkdir: vi.fn(),
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

vi.mock('../../services/spaceService', async () => {
  const actual = await vi.importActual<typeof import('../../services/spaceService')>('../../services/spaceService');
  return {
    ...actual,
    scanSpacesWithSideEffects: (...args: unknown[]) => mockScanSpacesWithSideEffects(...args),
    scanSpacesReadOnly: (...args: unknown[]) => mockScanSpacesReadOnly(...args),
    scanSuggestedSpaces: vi.fn(),
    scanForFrontmatterWarnings: (...args: unknown[]) => mockScanForFrontmatterWarnings(...args),
    createSpace: vi.fn(),
    initializeSpaceReadme: vi.fn(),
    removeSpace: vi.fn(),
    moveSpace: vi.fn(),
    renameSpace: vi.fn(),
    migrateSpacePathInSettings: vi.fn(),
    updateSpaceFrontmatter: vi.fn(),
    reconcileSpacesWithSettings: (...args: unknown[]) => mockReconcileSpacesWithSettings(...args),
    readSpaceReadmeFrontmatter: vi.fn(),
    migrateLegacyAgentsMd: vi.fn(),
    resolveViaSpaceName: vi.fn().mockResolvedValue(null),
  };
});

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

vi.mock('../../services/libraryBroadcaster', () => ({
  libraryBroadcaster: {
    broadcast: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
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
    listNotifications: vi.fn().mockResolvedValue([]),
    dismissNotification: vi.fn().mockResolvedValue(true),
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

const { registerLibraryHandlers } = await import('../libraryHandlers');

const MOCK_WORKSPACE = '/mock/workspace';

function getScanSpacesHandler(): (event: unknown, request?: unknown) => Promise<{
  success: boolean;
  spaces: unknown[];
  error?: string;
  parseWarnings?: Array<{ path: string; message: string }>;
  errors?: Array<{
    kind: 'access';
    path: string;
    operation?: 'workspace-root-readdir' | 'workspace-work-readdir';
    code?: string;
  }>;
}> {
  const handler = registeredHandlers.get('library:scan-spaces');
  expect(handler).toBeDefined();
  if (!handler) {
    throw new Error('Expected library:scan-spaces handler to be registered');
  }
  return handler as (event: unknown, request?: unknown) => Promise<{
    success: boolean;
    spaces: unknown[];
    error?: string;
    parseWarnings?: Array<{ path: string; message: string }>;
    errors?: Array<{
      kind: 'access';
      path: string;
      operation?: 'workspace-root-readdir' | 'workspace-work-readdir';
      code?: string;
    }>;
  }>;
}

function getCreateSpaceHandler(): (event: unknown, request: unknown) => Promise<{
  success: boolean;
  space?: unknown;
  error?: string;
}> {
  const handler = registeredHandlers.get('library:create-space');
  expect(handler).toBeDefined();
  if (!handler) {
    throw new Error('Expected library:create-space handler to be registered');
  }
  return handler as (event: unknown, request: unknown) => Promise<{
    success: boolean;
    space?: unknown;
    error?: string;
  }>;
}

function getUpdateSpaceAssociatedAccountsHandler(): (event: unknown, request: unknown) => Promise<{
  success: boolean;
  error?: string;
}> {
  const handler = registeredHandlers.get('library:update-space-associated-accounts');
  expect(handler).toBeDefined();
  if (!handler) {
    throw new Error('Expected library:update-space-associated-accounts handler to be registered');
  }
  return handler as (event: unknown, request: unknown) => Promise<{
    success: boolean;
    error?: string;
  }>;
}

function makeSpace(name: string): {
  name: string;
  path: string;
  absolutePath: string;
  type: 'project';
  isSymlink: false;
  hasReadme: true;
  status: 'ok';
} {
  return {
    name,
    path: name,
    absolutePath: `${MOCK_WORKSPACE}/${name}`,
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
  };
}

describe('library:scan-spaces dedupe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    registeredHandlers.clear();

    const settings = { coreDirectory: MOCK_WORKSPACE, spaces: [] } as unknown as AppSettings;
    mockGetSettings.mockReturnValue(settings);
    mockReconcileSpacesWithSettings.mockResolvedValue(settings.spaces);
    mockScanForFrontmatterWarnings.mockResolvedValue([]);
    mockScanSpacesReadOnly.mockResolvedValue([]);
    mockScanSpacesWithSideEffects.mockResolvedValue([]);

    registerLibraryHandlers({
      getSettings: () => settings,
      getSettingsStore: () => ({ store: settings }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins concurrent scan requests to one in-flight scanSpaces call', async () => {
    let resolveScan!: (spaces: ReturnType<typeof makeSpace>[]) => void;
    mockScanSpacesReadOnly.mockImplementation(
      () => new Promise((resolve) => { resolveScan = resolve as (spaces: ReturnType<typeof makeSpace>[]) => void; }),
    );
    const handler = getScanSpacesHandler();

    const one = handler({});
    const two = handler({});
    const three = handler({});

    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);

    resolveScan([makeSpace('Alpha')]);
    const [first, second, third] = await Promise.all([one, two, three]);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);
  });

  it('persists associated accounts atomically without writing undefined README emails', async () => {
    const { isFeatureEnabled } = await import('@core/featureGating');
    const spaceService = await import('../../services/spaceService');
    vi.mocked(isFeatureEnabled).mockReturnValue(true);
    vi.mocked(spaceService.createSpace).mockResolvedValue({
      name: 'Acme Corp',
      path: 'work/Acme Corp',
      absolutePath: `${MOCK_WORKSPACE}/work/Acme Corp`,
      type: 'company',
      isSymlink: false,
      hasReadme: true,
      description: 'Acme shared space',
      writable: true,
    } as Awaited<ReturnType<typeof spaceService.createSpace>>);
    vi.mocked(spaceService.updateSpaceFrontmatter).mockResolvedValue({ success: true });

    let latestSettings = {
      coreDirectory: MOCK_WORKSPACE,
      spaces: [
        {
          name: 'Other',
          path: 'Other',
          type: 'project',
          isSymlink: false,
          createdAt: 1,
        },
      ],
      userEmail: '[external-email]',
    } as unknown as AppSettings;
    mockUpdateSettingsAtomic.mockImplementation((updater: (current: AppSettings) => Partial<AppSettings>, options?: unknown) => {
      const partial = updater(latestSettings);
      latestSettings = { ...latestSettings, ...partial };
      expect(options).toEqual({ sync: true });
    });

    const handler = getCreateSpaceHandler();
    const result = await handler({}, {
      name: 'Acme Corp',
      type: 'company',
      location: 'workspace',
      description: 'Acme shared space',
      associatedAccounts: [],
    });

    expect(result.success).toBe(true);
    expect(spaceService.updateSpaceFrontmatter).toHaveBeenCalledWith(
      `${MOCK_WORKSPACE}/work/Acme Corp`,
      expect.not.objectContaining({ emails: expect.anything() }),
    );
    expect(latestSettings).toMatchObject({
      userEmail: '[external-email]',
      spaces: [
        expect.objectContaining({ path: 'Other' }),
        expect.objectContaining({ path: 'work/Acme Corp', associatedAccounts: [] }),
      ],
    });
  });

  it('fails local associated-account updates when the space is missing from settings', async () => {
    const handler = getUpdateSpaceAssociatedAccountsHandler();
    const settings = {
      coreDirectory: MOCK_WORKSPACE,
      spaces: [
        {
          name: 'Other',
          path: 'Other',
          type: 'project',
          isSymlink: false,
          createdAt: 1,
        },
      ],
    } as unknown as AppSettings;
    mockUpdateSettingsAtomic.mockImplementation((updater: (current: AppSettings) => Partial<AppSettings>, options?: unknown) => {
      expect(updater(settings)).toEqual({});
      expect(options).toEqual({ sync: true });
    });

    const result = await handler({}, {
      spacePath: 'work/Acme Corp',
      associatedAccounts: ['[external-email]'],
    });

    expect(result).toEqual({
      success: false,
      error: 'Space is not configured in local settings.',
    });
  });

  it('reuses completed result for five-second recent window, then rescans after expiry', async () => {
    mockScanSpacesReadOnly.mockResolvedValue([makeSpace('Alpha')]);
    const handler = getScanSpacesHandler();

    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(2);
  });

  it('drops recent cache immediately when invalidateSpaceScanCache is called', async () => {
    const { invalidateSpaceScanCache } = await import('../../services/spaceService');
    mockScanSpacesReadOnly.mockResolvedValue([makeSpace('Alpha')]);
    const handler = getScanSpacesHandler();

    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    invalidateSpaceScanCache(MOCK_WORKSPACE, 'test-invalidation');
    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate recent cache when an invalidated in-flight scan resolves later', async () => {
    const { invalidateSpaceScanCache } = await import('../../services/spaceService');
    let resolveFirstScan!: (spaces: ReturnType<typeof makeSpace>[]) => void;
    mockScanSpacesReadOnly.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirstScan = resolve as (spaces: ReturnType<typeof makeSpace>[]) => void; }),
    );
    mockScanSpacesReadOnly.mockResolvedValueOnce([makeSpace('Fresh')]);

    const handler = getScanSpacesHandler();
    const firstScan = handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);

    invalidateSpaceScanCache(MOCK_WORKSPACE, 'test-invalidation-race');

    resolveFirstScan([makeSpace('Stale')]);
    await firstScan;

    const postInvalidationResult = await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(2);
    expect(postInvalidationResult).toMatchObject({
      success: true,
      spaces: [expect.objectContaining({ name: 'Fresh' })],
    });

    // Fresh scan should populate recent cache for subsequent requests.
    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(2);
  });

  it('runs read-only scans by default and only triggers frontmatter warning scan with withRepair', async () => {
    mockScanSpacesReadOnly.mockResolvedValue([makeSpace('Alpha')]);
    mockScanSpacesWithSideEffects.mockResolvedValue([makeSpace('Alpha')]);
    const handler = getScanSpacesHandler();

    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);
    expect(mockScanSpacesReadOnly).toHaveBeenNthCalledWith(1, MOCK_WORKSPACE);
    expect(mockScanSpacesWithSideEffects).not.toHaveBeenCalled();
    expect(mockScanForFrontmatterWarnings).not.toHaveBeenCalled();

    await handler({}, { withRepair: true });
    expect(mockScanSpacesWithSideEffects).toHaveBeenCalledTimes(1);
    expect(mockScanSpacesWithSideEffects).toHaveBeenNthCalledWith(1, MOCK_WORKSPACE);
    expect(mockScanForFrontmatterWarnings).toHaveBeenCalledTimes(1);
  });

  it('returns access failures as unsuccessful results and does not cache them in the recent window', async () => {
    const { SpaceScanAccessError } = await import('../../services/spaceService');
    mockScanSpacesReadOnly.mockRejectedValueOnce(new SpaceScanAccessError({
      path: MOCK_WORKSPACE,
      operation: 'workspace-root-readdir',
      code: 'EACCES',
    }));
    mockScanSpacesReadOnly.mockResolvedValueOnce([makeSpace('Recovered')]);

    const handler = getScanSpacesHandler();

    const firstResult = await handler({});
    expect(firstResult).toMatchObject({
      success: false,
      error: 'access',
      spaces: [],
      errors: [
        {
          kind: 'access',
          path: MOCK_WORKSPACE,
          operation: 'workspace-root-readdir',
          code: 'EACCES',
        },
      ],
    });
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(1);

    const secondResult = await handler({});
    expect(secondResult).toMatchObject({
      success: true,
      spaces: [expect.objectContaining({ name: 'Recovered' })],
    });
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(2);

    // Successful retry should populate recent cache for immediate subsequent calls.
    await handler({});
    expect(mockScanSpacesReadOnly).toHaveBeenCalledTimes(2);
  });
});
