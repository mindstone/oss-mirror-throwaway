 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only: the RUNTIME `setWorkspaceFsExecutor`/`__resetWorkspaceFsExecutorForTesting`
// must be taken from the SAME module instance the code-under-test uses. This suite loads
// fileWatcherService (→ safeWalkDirectory → boundedWorkspaceFs) via `await import(...)`, a
// separate dynamic module graph from this file's static imports, so wiring the executor
// statically would target a DIFFERENT boundedWorkspaceFs instance and never take effect.
import type { WorkspaceFsExecutor, WorkspaceFsExecResult } from '@core/services/boundedWorkspaceFs';

const {
  mockLogger,
  eventListeners,
  mockDetectCloudStorage,
  mockFsAccess,
  mockFsReadFile,
  mockFsReadlink,
  mockFsReaddir,
  mockFsRealpath,
  mockFsStat,
  mockClearIndex,
  mockCloseIndex,
  mockGetIndexStatus,
  mockGetIndexedPaths,
  mockGetScanCompletedAt,
  mockGetTotalFilesAtCompletion,
  mockHasIndex,
  mockHydrateIndexedPathsCache,
  mockIndexFile,
  mockInitializeIndex,
  mockMarkScanComplete,
  mockNeedsReindexing,
  mockRefreshEnhancementCounts,
  mockRefreshReadTable,
  mockRemoveFileFromIndex,
  mockRemoveFilesFromIndex,
  mockRebuildWorkspaceSymlinkMap,
  mockGetWorkspaceSymlinkMap,
  mockStartEnhancement,
  mockStopEnhancement,
  mockGetSettings,
  mockIsEmbeddingServiceReady,
  mockWaitForModelReady,
  mockSourceMetadataInitForWorkspace,
  mockSourceMetadataIsEmpty,
  mockSourceMetadataIsSourcePath,
  mockSourceMetadataRemoveSource,
  mockSourceMetadataReconcile,
  mockEntityMetadataInitForWorkspace,
  mockEntityMetadataIsEmpty,
  mockEntityMetadataIsEntityFile,
  mockEntityMetadataRemoveEntity,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  eventListeners: new Map<string, Set<(filePath: string) => void>>(),
  mockDetectCloudStorage: vi.fn(),
  mockFsAccess: vi.fn(),
  mockFsReadFile: vi.fn(),
  mockFsReadlink: vi.fn(),
  mockFsReaddir: vi.fn(),
  mockFsRealpath: vi.fn(),
  mockFsStat: vi.fn(),
  mockClearIndex: vi.fn(),
  mockCloseIndex: vi.fn(),
  mockGetIndexStatus: vi.fn(),
  mockGetIndexedPaths: vi.fn(),
  mockGetScanCompletedAt: vi.fn(),
  mockGetTotalFilesAtCompletion: vi.fn(),
  mockHasIndex: vi.fn(),
  mockHydrateIndexedPathsCache: vi.fn(),
  mockIndexFile: vi.fn(),
  mockInitializeIndex: vi.fn(),
  mockMarkScanComplete: vi.fn(),
  mockNeedsReindexing: vi.fn(),
  mockRefreshEnhancementCounts: vi.fn(),
  mockRefreshReadTable: vi.fn(),
  mockRemoveFileFromIndex: vi.fn(),
  mockRemoveFilesFromIndex: vi.fn(),
  mockRebuildWorkspaceSymlinkMap: vi.fn(),
  mockGetWorkspaceSymlinkMap: vi.fn(),
  mockStartEnhancement: vi.fn(),
  mockStopEnhancement: vi.fn(),
  mockGetSettings: vi.fn(),
  mockIsEmbeddingServiceReady: vi.fn(),
  mockWaitForModelReady: vi.fn(),
  mockSourceMetadataInitForWorkspace: vi.fn(),
  mockSourceMetadataIsEmpty: vi.fn(),
  mockSourceMetadataIsSourcePath: vi.fn(),
  mockSourceMetadataRemoveSource: vi.fn(),
  mockSourceMetadataReconcile: vi.fn(),
  mockEntityMetadataInitForWorkspace: vi.fn(),
  mockEntityMetadataIsEmpty: vi.fn(),
  mockEntityMetadataIsEntityFile: vi.fn(),
  mockEntityMetadataRemoveEntity: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: mockLogger,
  createScopedLogger: () => mockLogger,
}));

// S4.1a — safeWalkDirectory now routes cloud-classified reads (here: a CONFIGURED
// cloud space, classified by containment) through boundedWorkspaceFs's CLOUD lane,
// i.e. the executor — NOT the `node:fs/promises` mock the fixtures drive. Wire an
// executor that delegates to those same mock fns so the cloud-space walk yields
// byte-identical output to the pre-boundary (pattern-local) walk. LOCAL reads still
// take the boundary's local lane (the `node:fs/promises` mock) unchanged.
function execErr<T>(error: unknown): WorkspaceFsExecResult<T> {
  return { ok: false, reason: 'error', error: error as NodeJS.ErrnoException };
}
// NOTE (S4.2 cleanup follow-up): this mock-backed executor was the seam for the
// producer tests that S4.2 deleted; it is now unused (kept `_`-prefixed rather than
// removed to avoid cascading the `execErr` + type-import removal during a sync). Safe
// to delete wholesale in a follow-up.
function _makeMockBackedExecutor(): WorkspaceFsExecutor {
  const realpath = async (p: string): Promise<WorkspaceFsExecResult<string>> => {
    try {
      return { ok: true, value: (await mockFsRealpath(p)) as string };
    } catch (e) {
      return execErr(e);
    }
  };
  const readdirWithFileTypes = async (p: string) => {
    try {
      const ents = (await mockFsReaddir(p)) as Array<{
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
      }>;
      return {
        ok: true as const,
        value: ents.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          isSymbolicLink: e.isSymbolicLink(),
        })),
      };
    } catch (e) {
      return execErr(e);
    }
  };
  const stat = async (p: string) => {
    try {
      const s = (await mockFsStat(p)) as {
        mtimeMs?: number;
        ctimeMs?: number;
        size?: number;
        isFile?: () => boolean;
        isDirectory?: () => boolean;
        isSymbolicLink?: () => boolean;
      };
      return {
        ok: true as const,
        value: {
          mtimeMs: s.mtimeMs ?? 0,
          ctimeMs: s.ctimeMs ?? 0,
          size: s.size ?? 0,
          isDirectory: s.isDirectory?.() ?? false,
          isFile: s.isFile?.() ?? false,
          isSymbolicLink: s.isSymbolicLink?.() ?? false,
        },
      };
    } catch (e) {
      return execErr(e);
    }
  };
  const readlink = async (p: string): Promise<WorkspaceFsExecResult<string>> => {
    try {
      return { ok: true, value: (await mockFsReadlink(p)) as string };
    } catch (e) {
      return execErr(e);
    }
  };
  const readdir = async (p: string): Promise<WorkspaceFsExecResult<string[]>> => {
    try {
      const ents = (await mockFsReaddir(p)) as Array<{ name: string } | string>;
      return { ok: true, value: ents.map((e) => (typeof e === 'string' ? e : e.name)) };
    } catch (e) {
      return execErr(e);
    }
  };
  const readFile = async (p: string, enc: BufferEncoding): Promise<WorkspaceFsExecResult<string>> => {
    try {
      return { ok: true, value: (await mockFsReadFile(p, enc)) as string };
    } catch (e) {
      return execErr(e);
    }
  };
  const access = async (p: string): Promise<WorkspaceFsExecResult<true>> => {
    try {
      await mockFsAccess(p);
      return { ok: true, value: true };
    } catch (e) {
      return execErr(e);
    }
  };
  return {
    stat,
    lstat: stat,
    realpath,
    readlink,
    readdir,
    readdirWithFileTypes,
    readFile,
    readFileBytes: async (p: string) => {
      try {
        return { ok: true as const, value: (await mockFsReadFile(p)) as Buffer };
      } catch (e) {
        return execErr(e);
      }
    },
    access,
  } as WorkspaceFsExecutor;
}

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => null,
}));

vi.mock('node:fs/promises', () => ({
  default: {
    access: mockFsAccess,
    readFile: mockFsReadFile,
    readlink: mockFsReadlink,
    readdir: mockFsReaddir,
    realpath: mockFsRealpath,
    stat: mockFsStat,
  },
  access: mockFsAccess,
  readFile: mockFsReadFile,
  readlink: mockFsReadlink,
  readdir: mockFsReaddir,
  realpath: mockFsRealpath,
  stat: mockFsStat,
}));

vi.mock('../utils/cloudStorageUtils', () => ({
  detectCloudStorage: mockDetectCloudStorage,
  shouldSkipCloudSymlinkTarget: (p: string) => {
    const info = mockDetectCloudStorage(p);
    return info.isCloud ? { skip: true, provider: info.provider } : { skip: false };
  },
}));

vi.mock('../workspaceWatcherService', () => ({
  workspaceWatcherService: {
    on: vi.fn((event: string, listener: (filePath: string) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
      }
      eventListeners.get(event)?.add(listener);
    }),
    off: vi.fn((event: string, listener: (filePath: string) => void) => {
      eventListeners.get(event)?.delete(listener);
    }),
  },
}));

vi.mock('../fileIndexService', () => ({
  initializeIndex: mockInitializeIndex,
  indexFile: mockIndexFile,
  removeFileFromIndex: mockRemoveFileFromIndex,
  removeFilesFromIndex: mockRemoveFilesFromIndex,
  rebuildWorkspaceSymlinkMap: mockRebuildWorkspaceSymlinkMap,
  getWorkspaceSymlinkMap: mockGetWorkspaceSymlinkMap,
  refreshReadTable: mockRefreshReadTable,
  needsReindexing: mockNeedsReindexing,
  closeIndex: mockCloseIndex,
  clearIndex: mockClearIndex,
  getIndexStatus: mockGetIndexStatus,
  getScanCompletedAt: mockGetScanCompletedAt,
  getTotalFilesAtCompletion: mockGetTotalFilesAtCompletion,
  markScanComplete: mockMarkScanComplete,
  hydrateIndexedPathsCache: mockHydrateIndexedPathsCache,
  hasIndex: mockHasIndex,
  refreshEnhancementCounts: mockRefreshEnhancementCounts,
  getIndexedPaths: mockGetIndexedPaths,
  reconcileFileVectorsIfNeeded: vi.fn(async () => ({
    recomputed: 0,
    deleted: 0,
    skipped: 0,
    durationMs: 0,
  })),
}));

vi.mock('../sourceMetadataStore', () => ({
  initForWorkspace: mockSourceMetadataInitForWorkspace,
  isEmpty: mockSourceMetadataIsEmpty,
  isSourcePath: mockSourceMetadataIsSourcePath,
  removeSource: mockSourceMetadataRemoveSource,
  reconcileSourceMetadataWithFilesystem: mockSourceMetadataReconcile,
  indexSource: vi.fn(),
}));

vi.mock('../entityMetadataStore', () => ({
  initForWorkspace: mockEntityMetadataInitForWorkspace,
  isEmpty: mockEntityMetadataIsEmpty,
  removeEntity: mockEntityMetadataRemoveEntity,
  isEntityFile: mockEntityMetadataIsEntityFile,
  indexEntity: vi.fn(),
}));

vi.mock('../embeddingService', () => ({
  waitForModelReady: mockWaitForModelReady,
  isEmbeddingServiceReady: mockIsEmbeddingServiceReady,
}));

vi.mock('../enhancementService', () => ({
  stopEnhancement: mockStopEnhancement,
  startEnhancement: mockStartEnhancement,
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: mockGetSettings,
}));

vi.mock('../utils/systemUtils', () => ({
  tryConvertToWorkspacePath: () => null,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function emitWorkspaceEvent(
  event: 'file:added' | 'file:changed' | 'file:removed' | 'dir:added' | 'dir:removed',
  filePath: string,
): void {
  for (const listener of eventListeners.get(event) ?? []) {
    listener(filePath);
  }
}

function findLogCall(
  mockFn: ReturnType<typeof vi.fn>,
  message: string
): [Record<string, unknown>, string] | undefined {
  return mockFn.mock.calls.find(([, loggedMessage]) => loggedMessage === message) as
    | [Record<string, unknown>, string]
    | undefined;
}

let activeService: {
  pauseWatching: () => Promise<void>;
  startWatching: (workspacePath: string) => Promise<void>;
  stopWatching: () => Promise<void>;
  getWatcherStatus: () => { pendingFiles: number };
  getIndexerStats: () => {
    queueItemsEnqueued: number;
    queueItemsProcessed: number;
    queueItemsFailed: number;
    blurPauseCount: number;
    blurPauseTotalMs: number;
    maxPauseTimeoutsFired: number;
  };
} | null = null;
let activeScheduler: {
  _resetForTesting: () => void;
  _setBlurredForTesting: (blurred: boolean) => void;
  _setHeadlessModeForTesting: (headless: boolean) => void;
} | null = null;

async function loadHarness() {
  const scheduler = await import('../visibilityAwareScheduler');
  scheduler._resetForTesting();
  scheduler._setHeadlessModeForTesting(false);

  const service = await import('../fileWatcherService');

  // Removal Coordinator (Stage 4a): the watcher now routes ALL removals through
  // the coordinator. Wire it (same module instance after vi.resetModules) to the
  // SAME store mocks the test asserts on, so these tests verify the watcher
  // reaches those removers THROUGH the coordinator — i.e. behavior is preserved.
  const coordinator = await import('../indexRemovalCoordinator');
  coordinator.configureIndexRemovalCoordinator({
    removeSource: mockSourceMetadataRemoveSource,
    isSourcePath: mockSourceMetadataIsSourcePath,
    removeEntity: mockEntityMetadataRemoveEntity,
    removeFileFromIndex: mockRemoveFileFromIndex,
    removeFilesFromIndex: mockRemoveFilesFromIndex,
  });

  await service.startWatching('/workspace');
  await vi.advanceTimersByTimeAsync(200);

  activeScheduler = scheduler;
  activeService = service;
  return { scheduler, service };
}

async function preparePausedQueue(options?: { maxPauseMs?: string }) {
  if (options?.maxPauseMs !== undefined) {
    process.env.REBEL_INDEXER_MAX_PAUSE_MS = options.maxPauseMs;
  } else {
    delete process.env.REBEL_INDEXER_MAX_PAUSE_MS;
  }
  process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '1';

  const { scheduler, service } = await loadHarness();
  const firstFileGate = createDeferred<boolean>();

  mockNeedsReindexing.mockImplementation((filePath: string) => {
    if (filePath.endsWith('first.md')) {
      return firstFileGate.promise;
    }
    return Promise.resolve(true);
  });

  emitWorkspaceEvent('file:added', '/workspace/first.md');
  emitWorkspaceEvent('file:added', '/workspace/second.md');
  await vi.advanceTimersByTimeAsync(0);

  scheduler._setBlurredForTesting(true);
  await vi.advanceTimersByTimeAsync(15_000);
  firstFileGate.resolve(true);
  await vi.advanceTimersByTimeAsync(20);

  return { scheduler, service };
}

describe('fileWatcherService blur pause', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
    eventListeners.clear();

    delete process.env.REBEL_INDEXER_PAUSE_ON_BLUR;
    delete process.env.REBEL_INDEXER_PAUSE_ON_ACTIVE_TURN;
    delete process.env.REBEL_INDEXER_MAX_PAUSE_MS;
    delete process.env.REBEL_FORCE_FULL_INDEX_RESCAN;

    mockDetectCloudStorage.mockReturnValue({ isCloud: false, provider: null });
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue('');
    mockFsReadlink.mockResolvedValue('/workspace/target');
    mockFsReaddir.mockResolvedValue([]);
    mockFsRealpath.mockImplementation(async (filePath: string) => filePath);
    mockFsStat.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      mtimeMs: Date.now(),
    });

    mockInitializeIndex.mockResolvedValue(undefined);
    mockIndexFile.mockResolvedValue(1);
    mockRemoveFileFromIndex.mockResolvedValue(undefined);
    mockRemoveFilesFromIndex.mockResolvedValue(0);
    mockRefreshReadTable.mockResolvedValue(undefined);
    mockNeedsReindexing.mockResolvedValue(true);
    mockCloseIndex.mockResolvedValue(undefined);
    mockClearIndex.mockResolvedValue(undefined);
    mockGetScanCompletedAt.mockImplementation(() => Date.now());
    mockGetTotalFilesAtCompletion.mockReturnValue(0);
    mockMarkScanComplete.mockResolvedValue(undefined);
    mockHydrateIndexedPathsCache.mockResolvedValue(undefined);
    mockHasIndex.mockReturnValue(false);
    mockRefreshEnhancementCounts.mockResolvedValue(undefined);
    mockGetIndexedPaths.mockReturnValue([]);
    mockGetIndexStatus.mockImplementation(() => ({
      indexedFiles: mockIndexFile.mock.calls.length,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    }));

    mockSourceMetadataInitForWorkspace.mockImplementation(() => {});
    mockSourceMetadataIsEmpty.mockReturnValue(false);
    mockSourceMetadataIsSourcePath.mockReturnValue(false);
    mockSourceMetadataRemoveSource.mockImplementation(() => {});
    mockSourceMetadataReconcile.mockResolvedValue(0);
    mockEntityMetadataInitForWorkspace.mockImplementation(() => {});
    mockEntityMetadataIsEmpty.mockReturnValue(false);
    mockEntityMetadataIsEntityFile.mockReturnValue(false);
    mockEntityMetadataRemoveEntity.mockImplementation(() => {});

    mockWaitForModelReady.mockResolvedValue(undefined);
    mockIsEmbeddingServiceReady.mockReturnValue(true);
    mockStopEnhancement.mockImplementation(() => {});
    mockStartEnhancement.mockResolvedValue(undefined);
    mockGetSettings.mockReturnValue({ enhancementUserRequested: false });
  });

  afterEach(async () => {
    if (activeService) {
      await activeService.stopWatching();
    }
    activeScheduler?._resetForTesting();
    activeService = null;
    activeScheduler = null;
    eventListeners.clear();
    vi.useRealTimers();
    vi.resetModules();
  });

  // RC-1 refinement (Codex F1): the startWatching symlink telemetry logs the
  // RESOLVED target, which for Google Drive is
  // ~/Library/CloudStorage/GoogleDrive-<email>/… — the user's email — and lands
  // in shared diagnostics bundles. The target must be redacted at source.
  it('redacts the user email + home dir from the symlink-telemetry log target', async () => {
    const cloudTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-jane@example.com/Shared drives/Company Memories';

    // analyzeWorkspaceSymlinks reads the workspace dir: one symlink entry.
    mockFsReaddir.mockImplementation(async (_dir: string, opts?: { withFileTypes?: boolean }) => {
      if (opts?.withFileTypes) {
        return [
          { name: 'Company Memories', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false },
        ];
      }
      return [];
    });
    mockFsReadlink.mockResolvedValue(cloudTarget);
    mockFsRealpath.mockImplementation(async (p: string) => (p.endsWith('Company Memories') ? cloudTarget : p));
    mockDetectCloudStorage.mockImplementation((p: string) =>
      p.includes('GoogleDrive-') ? { isCloud: true, provider: 'google_drive' } : { isCloud: false, provider: null },
    );

    await loadHarness();

    // Find the symlink-telemetry info log.
    const symlinkLog = mockLogger.info.mock.calls.find(
      ([, msg]) => msg === 'Workspace contains symlinks - followSymlinks:true will traverse these',
    );
    expect(symlinkLog).toBeDefined();
    const payload = symlinkLog?.[0] as {
      symlinkTargets: Array<{ name: string; target: string; cloudProvider: string | null }>;
    };
    const logged = payload.symlinkTargets[0];

    // The provider is still surfaced (debuggable)...
    expect(logged.cloudProvider).toBe('google_drive');
    // ...but the raw email and the /Users/<name> home path are gone.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('jane@example.com');
    expect(serialized).not.toContain('/Users/test');
    expect(logged.target).toContain('***@***.***');
    // The basename is preserved so the symlink is still identifiable.
    expect(logged.target).toContain('Company Memories');
  });

  // Stage 5: analyzeWorkspaceSymlinks does `fs.readdir(workspacePath)` for symlink
  // TELEMETRY. If the workspace ROOT is itself a cloud mount, that readdir would
  // block the main thread unbounded on a dead FUSE mount. It must degrade: skip the
  // readdir entirely (pure-string detectCloudStorage gate), still surface the
  // provider, and never enumerate symlinks.
  it('SKIPS the symlink-telemetry readdir when the workspace ROOT is cloud-classified', async () => {
    // A workspace ROOT whose path the (real) classifier flags as cloud. The
    // telemetry `fs.readdir(root)` must NOT fire — if this root were a dead FUSE
    // mount, that readdir would block the main thread unbounded.
    const cloudRoot = '/Users/test/Library/CloudStorage/GoogleDrive-jane@example.com/My Drive/ws';
    // detectCloudStorage in this harness resolves to the REAL impl, which matches
    // the CloudStorage pattern. Make the mock agree too (belt + braces), but the
    // assertion below proves the readdir of the root never happened.
    mockDetectCloudStorage.mockImplementation((p: string) =>
      p.includes('CloudStorage') ? { isCloud: true, provider: 'google_drive' } : { isCloud: false, provider: null },
    );
    // Track whether the workspace ROOT was ever readdir'd (telemetry or walk).
    let cloudRootReaddir = 0;
    mockFsReaddir.mockImplementation(async (dir: string) => {
      if (dir === cloudRoot) cloudRootReaddir += 1;
      return [];
    });

    const scheduler = await import('../visibilityAwareScheduler');
    scheduler._resetForTesting();
    scheduler._setHeadlessModeForTesting(false);
    const service = await import('../fileWatcherService');
    const coordinator = await import('../indexRemovalCoordinator');
    coordinator.configureIndexRemovalCoordinator({
      removeSource: mockSourceMetadataRemoveSource,
      isSourcePath: mockSourceMetadataIsSourcePath,
      removeEntity: mockEntityMetadataRemoveEntity,
      removeFileFromIndex: mockRemoveFileFromIndex,
      removeFilesFromIndex: mockRemoveFilesFromIndex,
    });
    await service.startWatching(cloudRoot);
    await vi.advanceTimersByTimeAsync(200);
    activeScheduler = scheduler;
    activeService = service;

    // The telemetry log fired (cloudStorageProvider is set) and reports the skip.
    const cloudLog = mockLogger.info.mock.calls.find(
      ([, msg]) => msg === 'Workspace is in cloud storage',
    );
    expect(cloudLog).toBeDefined();
    const payload = cloudLog?.[0] as {
      rootIsCloudSkipped: boolean;
      symlinkCount: number;
      symlinkTargets?: unknown[];
    };
    expect(payload.rootIsCloudSkipped).toBe(true);
    expect(payload.symlinkCount).toBe(0);
    expect(payload.symlinkTargets ?? []).toHaveLength(0);
    // The TELEMETRY readdir of the cloud root never happened — analyzeWorkspaceSymlinks
    // short-circuited before touching the (possibly-dead) mount.
    expect(cloudRootReaddir).toBe(0);
  });

  it('keeps draining the queue while blurred when the flag is off', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '0';
    const { scheduler } = await loadHarness();

    scheduler._setBlurredForTesting(true);
    emitWorkspaceEvent('file:added', '/workspace/default-off.md');
    await vi.advanceTimersByTimeAsync(25);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(1);
    expect(mockIndexFile).toHaveBeenCalledTimes(1);
  });

  // S2 (260529 GPT-5.5 review): prove the dir:added/dir:removed SUBSCRIPTION is
  // wired to rebuildWorkspaceSymlinkMap, not just that a direct call rebuilds.
  // A directory add/remove can introduce or drop a symlinked mount, so the watcher
  // must invalidate the cached symlink map on these events.
  it('invokes rebuildWorkspaceSymlinkMap when the workspace watcher emits dir:added / dir:removed', async () => {
    await loadHarness();

    // The subscription must have registered listeners for both dir events.
    expect(eventListeners.get('dir:added')?.size ?? 0).toBeGreaterThan(0);
    expect(eventListeners.get('dir:removed')?.size ?? 0).toBeGreaterThan(0);

    mockRebuildWorkspaceSymlinkMap.mockClear();

    emitWorkspaceEvent('dir:added', '/workspace/new-dir');
    expect(mockRebuildWorkspaceSymlinkMap).toHaveBeenCalledTimes(1);

    emitWorkspaceEvent('dir:removed', '/workspace/new-dir');
    expect(mockRebuildWorkspaceSymlinkMap).toHaveBeenCalledTimes(2);
  });

  it('skips foreground startup rescan when an existing index is usable and schedules background discovery', async () => {
    mockGetScanCompletedAt.mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    mockGetTotalFilesAtCompletion.mockReturnValue(null);
    mockGetIndexStatus.mockReturnValue({
      indexedFiles: 17655,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    });

    await loadHarness();

    const skipLog = findLogCall(mockLogger.info, 'Skipping foreground full rescan on startup');
    expect(skipLog).toBeDefined();
    expect(skipLog?.[0]).toEqual(expect.objectContaining({
      skipReason: 'existing-index',
      existingIndexedFileCount: 17655,
      backgroundDiscoveryScheduled: true,
    }));
    expect(findLogCall(mockLogger.info, 'Scheduled background file discovery')).toBeDefined();
  });

  it('indexes files added while the app was closed via delayed background discovery', async () => {
    mockGetScanCompletedAt.mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    mockGetTotalFilesAtCompletion.mockReturnValue(1);
    mockGetIndexStatus.mockReturnValue({
      indexedFiles: 1,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    });
    mockFsReaddir.mockResolvedValue([
      {
        name: 'offline.md',
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    ]);

    await loadHarness();
    expect(mockIndexFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(50);

    expect(mockNeedsReindexing).toHaveBeenCalledWith('/workspace/offline.md');
    expect(mockIndexFile).toHaveBeenCalledWith('/workspace/offline.md', '/workspace');
    expect(findLogCall(mockLogger.info, 'Background file discovery complete')).toBeDefined();
  });

  it('does not finalize the scan before scheduled background discovery completes', async () => {
    mockGetScanCompletedAt.mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    mockGetTotalFilesAtCompletion.mockReturnValue(1);
    mockGetIndexStatus.mockReturnValue({
      indexedFiles: 1,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    });

    await loadHarness();

    emitWorkspaceEvent('file:added', '/workspace/live-before-background.md');
    await vi.advanceTimersByTimeAsync(50);

    expect(mockIndexFile).toHaveBeenCalledWith('/workspace/live-before-background.md', '/workspace');
    expect(mockMarkScanComplete).not.toHaveBeenCalled();
    expect(mockRefreshEnhancementCounts).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(50);

    expect(mockMarkScanComplete).toHaveBeenCalledTimes(1);
    expect(mockRefreshEnhancementCounts).toHaveBeenCalledTimes(1);
  });

  it('waits for active queue processing before filtering background-discovered files', async () => {
    mockGetScanCompletedAt.mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    mockGetTotalFilesAtCompletion.mockReturnValue(1);
    mockGetIndexStatus.mockReturnValue({
      indexedFiles: 1,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    });
    mockFsReaddir.mockResolvedValue([
      {
        name: 'offline.md',
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    ]);
    const liveNeedsReindexing = createDeferred<boolean>();
    mockNeedsReindexing.mockImplementation((filePath: string) => {
      if (filePath.endsWith('live-before-background.md')) {
        return liveNeedsReindexing.promise;
      }
      return Promise.resolve(true);
    });

    await loadHarness();
    emitWorkspaceEvent('file:added', '/workspace/live-before-background.md');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockNeedsReindexing).not.toHaveBeenCalledWith('/workspace/offline.md');
    expect(mockIndexFile).not.toHaveBeenCalled();

    liveNeedsReindexing.resolve(true);
    await vi.advanceTimersByTimeAsync(200);

    expect(mockIndexFile).toHaveBeenCalledWith('/workspace/live-before-background.md', '/workspace');
    expect(mockNeedsReindexing).toHaveBeenCalledWith('/workspace/offline.md');
    expect(mockIndexFile).toHaveBeenCalledWith('/workspace/offline.md', '/workspace');
    expect(mockMarkScanComplete).toHaveBeenCalledTimes(1);
  });

  it('does not let background-discovered adds replace live removals', async () => {
    mockGetScanCompletedAt.mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    mockGetTotalFilesAtCompletion.mockReturnValue(1);
    mockGetIndexStatus.mockReturnValue({
      indexedFiles: 1,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    });
    let readdirCount = 0;
    mockFsReaddir.mockImplementation(async () => {
      readdirCount++;
      if (readdirCount === 2) {
        emitWorkspaceEvent('file:removed', '/workspace/offline.md');
        return [
          {
            name: 'offline.md',
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          },
        ];
      }
      return [];
    });

    await loadHarness();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(50);

    expect(mockRemoveFileFromIndex).toHaveBeenCalledWith('/workspace/offline.md', { skipReadRefresh: true });
    expect(mockIndexFile).not.toHaveBeenCalledWith('/workspace/offline.md', '/workspace');
  });

  it('waits for a processor that is still awaiting embedding readiness before background filtering', async () => {
    mockGetScanCompletedAt.mockReturnValue(Date.now() - 2 * 60 * 60 * 1000);
    mockGetTotalFilesAtCompletion.mockReturnValue(1);
    mockGetIndexStatus.mockReturnValue({
      indexedFiles: 1,
      pendingFiles: 0,
      isWatching: true,
      status: 'watching',
    });
    mockFsReaddir.mockResolvedValue([
      {
        name: 'offline.md',
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      },
    ]);
    const modelReady = createDeferred<void>();
    mockIsEmbeddingServiceReady.mockReturnValue(false);
    mockWaitForModelReady.mockReturnValue(modelReady.promise);

    await loadHarness();
    emitWorkspaceEvent('file:added', '/workspace/live-before-model-ready.md');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockNeedsReindexing).not.toHaveBeenCalledWith('/workspace/offline.md');

    mockIsEmbeddingServiceReady.mockReturnValue(true);
    modelReady.resolve();
    await vi.advanceTimersByTimeAsync(200);

    expect(mockIndexFile).toHaveBeenCalledWith('/workspace/live-before-model-ready.md', '/workspace');
    expect(mockNeedsReindexing).toHaveBeenCalledWith('/workspace/offline.md');
    expect(mockIndexFile).toHaveBeenCalledWith('/workspace/offline.md', '/workspace');
  });

  // Regression guard: without this test, a bug that makes the pause logic always-on
  // (ignoring REBEL_INDEXER_PAUSE_ON_BLUR) could slip through because the single-item
  // flag-off test above finishes processing before the 15s debounce engages.
  it('drains multiple queued items across a sustained 15s+ blur when flag is off', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '0';
    const { scheduler } = await loadHarness();
    const firstFileGate = createDeferred<boolean>();

    mockNeedsReindexing.mockImplementation((filePath: string) => {
      if (filePath.endsWith('first.md')) {
        return firstFileGate.promise;
      }
      return Promise.resolve(true);
    });

    emitWorkspaceEvent('file:added', '/workspace/first.md');
    emitWorkspaceEvent('file:added', '/workspace/second.md');
    await vi.advanceTimersByTimeAsync(0);

    scheduler._setBlurredForTesting(true);
    // Sustain the blur well past the 15s debounce — a broken flag gate would pause here.
    await vi.advanceTimersByTimeAsync(30_000);

    firstFileGate.resolve(true);
    await vi.advanceTimersByTimeAsync(50);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(2);
    expect(mockIndexFile).toHaveBeenCalledTimes(2);
    expect(findLogCall(mockLogger.info, 'Indexer paused on blur')).toBeUndefined();
    expect(findLogCall(mockLogger.info, 'Indexer resumed on focus')).toBeUndefined();
  });

  it('awaits focus after a sustained 15s blur without processing the next item', async () => {
    await preparePausedQueue();

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(1);
    expect(mockIndexFile).toHaveBeenCalledTimes(1);
  });

  it('logs an info-level pause-engaged signal when the 15s debounce fires', async () => {
    await preparePausedQueue();

    const engageLog = findLogCall(mockLogger.info, 'Indexer paused on blur');
    expect(engageLog).toBeDefined();
    expect(engageLog?.[0]).toEqual(
      expect.objectContaining({
        queueSize: expect.any(Number),
        maxPauseMs: expect.any(Number),
        reason: 'blur',
      })
    );
  });

  it('does not engage pause for transient blur shorter than the debounce', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '1';
    const { scheduler } = await loadHarness();
    const firstFileGate = createDeferred<boolean>();

    mockNeedsReindexing.mockImplementation((filePath: string) => {
      if (filePath.endsWith('first.md')) {
        return firstFileGate.promise;
      }
      return Promise.resolve(true);
    });

    emitWorkspaceEvent('file:added', '/workspace/first.md');
    emitWorkspaceEvent('file:added', '/workspace/second.md');
    await vi.advanceTimersByTimeAsync(0);

    scheduler._setBlurredForTesting(true);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler._setBlurredForTesting(false);

    firstFileGate.resolve(true);
    await vi.advanceTimersByTimeAsync(25);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(2);
    expect(mockIndexFile).toHaveBeenCalledTimes(2);
    expect(findLogCall(mockLogger.info, 'Indexer resumed on focus')).toBeUndefined();
  });

  it('cancels the stale debounce timer across blur-focus-blur bounce sequences', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '1';
    const { scheduler } = await loadHarness();
    const firstFileGate = createDeferred<boolean>();

    mockNeedsReindexing.mockImplementation((filePath: string) => {
      if (filePath.endsWith('first.md')) {
        return firstFileGate.promise;
      }
      return Promise.resolve(true);
    });

    emitWorkspaceEvent('file:added', '/workspace/first.md');
    emitWorkspaceEvent('file:added', '/workspace/second.md');
    await vi.advanceTimersByTimeAsync(0);

    scheduler._setBlurredForTesting(true);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler._setBlurredForTesting(false);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler._setBlurredForTesting(true);

    await vi.advanceTimersByTimeAsync(5_000);
    firstFileGate.resolve(true);
    await vi.advanceTimersByTimeAsync(25);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(2);
    expect(mockIndexFile).toHaveBeenCalledTimes(2);
  });

  it('seeds the debounce immediately when queue processing starts while already blurred', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '1';
    const { scheduler } = await loadHarness();
    const firstFileGate = createDeferred<boolean>();

    scheduler._setBlurredForTesting(true);

    mockNeedsReindexing.mockImplementation((filePath: string) => {
      if (filePath.endsWith('first.md')) {
        return firstFileGate.promise;
      }
      return Promise.resolve(true);
    });

    emitWorkspaceEvent('file:added', '/workspace/first.md');
    emitWorkspaceEvent('file:added', '/workspace/second.md');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(15_000);
    firstFileGate.resolve(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(1);
    expect(mockIndexFile).toHaveBeenCalledTimes(1);
  });

  it('resumes on focus, processes remaining items, and logs a positive pause duration', async () => {
    const { scheduler, service } = await preparePausedQueue();

    mockLogger.info.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler._setBlurredForTesting(false);
    await vi.advanceTimersByTimeAsync(25);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(2);
    expect(mockIndexFile).toHaveBeenCalledTimes(2);

    const resumeLog = findLogCall(mockLogger.info, 'Indexer resumed on focus');
    expect(resumeLog).toBeDefined();
    expect(resumeLog?.[0]).toEqual(
      expect.objectContaining({
        queueSize: 1,
        durationMs: expect.any(Number),
      })
    );
    expect((resumeLog?.[0].durationMs as number) > 0).toBe(true);
    expect(service.getIndexerStats()).toEqual(
      expect.objectContaining({
        queueItemsEnqueued: 2,
        queueItemsProcessed: 2,
        queueItemsFailed: 0,
        blurPauseCount: 1,
        blurPauseTotalMs: expect.any(Number),
        maxPauseTimeoutsFired: 0,
      })
    );
    expect(service.getIndexerStats().blurPauseTotalMs).toBeGreaterThan(0);
  });

  it('aborts a paused wait cleanly with no orphaned listeners or timers', async () => {
    const { scheduler, service } = await preparePausedQueue();

    mockLogger.debug.mockClear();
    await service.pauseWatching();
    await vi.advanceTimersByTimeAsync(0);

    const abortLog = findLogCall(mockLogger.debug, 'Indexer pause aborted (shutdown)');
    expect(abortLog).toBeDefined();
    expect(abortLog?.[0]).toEqual(expect.objectContaining({ queueSize: 0 }));
    expect(vi.getTimerCount()).toBe(0);

    scheduler._setBlurredForTesting(false);
    scheduler._setBlurredForTesting(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('warns and falls back to default max-pause when REBEL_INDEXER_MAX_PAUSE_MS is invalid', async () => {
    await preparePausedQueue({ maxPauseMs: '-1000' });

    const warnLog = findLogCall(
      mockLogger.warn,
      'Invalid REBEL_INDEXER_MAX_PAUSE_MS; falling back to default 30 min'
    );
    expect(warnLog).toBeDefined();
    expect(warnLog?.[0]).toEqual(expect.objectContaining({ raw: '-1000' }));
  });

  it('resumes under degraded mode after the max pause timeout and logs queueSize plus duration', async () => {
    const { service } = await preparePausedQueue({ maxPauseMs: '5000' });

    mockLogger.warn.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(25);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(2);
    expect(mockIndexFile).toHaveBeenCalledTimes(2);

    const timeoutLog = findLogCall(mockLogger.warn, 'Indexer max-pause exceeded; resuming under degraded mode');
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog?.[0]).toEqual(
      expect.objectContaining({
        queueSize: 1,
        durationMs: expect.any(Number),
      })
    );
    expect((timeoutLog?.[0].durationMs as number) >= 5_000).toBe(true);
    expect(service.getIndexerStats().maxPauseTimeoutsFired).toBe(1);
  });

  it('preserves the exact stuck watchdog reason in turn-active degraded logs', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '0';
    process.env.REBEL_INDEXER_PAUSE_ON_ACTIVE_TURN = '1';
    process.env.REBEL_INDEXER_MAX_PAUSE_MS = '1000';
    await loadHarness();

    const { agentTurnRegistry } = await import('@core/services/agentTurnRegistry');
    const turnId = 'filewatcher-turn-active-degraded';
    agentTurnRegistry.setActiveTurnController(turnId, new AbortController());

    try {
      mockLogger.warn.mockClear();
      emitWorkspaceEvent('file:added', '/workspace/turn-active-degraded.md');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_100);
      await vi.advanceTimersByTimeAsync(50);

      expect(mockIndexFile).toHaveBeenCalledWith('/workspace/turn-active-degraded.md', '/workspace');

      // R14: the consumer must preserve the reason carried on the degraded wait outcome.
      const degradedLog = findLogCall(
        mockLogger.warn,
        'Indexer entered degraded mode due stuck active-turn signal; resuming indexing'
      );
      expect(degradedLog).toBeDefined();
      expect(degradedLog?.[0]).toEqual(
        expect.objectContaining({
          reason: 'stuck_active_turn_signal',
        })
      );
    } finally {
      agentTurnRegistry.cleanupTurn(turnId);
    }
  });

  it('processes every queued item across a pause and resume cycle without data loss', async () => {
    process.env.REBEL_INDEXER_PAUSE_ON_BLUR = '1';
    const { scheduler, service } = await loadHarness();
    const firstFileGate = createDeferred<boolean>();

    mockNeedsReindexing.mockImplementation((filePath: string) => {
      if (filePath.endsWith('first.md')) {
        return firstFileGate.promise;
      }
      return Promise.resolve(true);
    });

    emitWorkspaceEvent('file:added', '/workspace/first.md');
    emitWorkspaceEvent('file:added', '/workspace/second.md');
    emitWorkspaceEvent('file:added', '/workspace/third.md');
    await vi.advanceTimersByTimeAsync(0);

    scheduler._setBlurredForTesting(true);
    await vi.advanceTimersByTimeAsync(15_000);
    firstFileGate.resolve(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(1);

    scheduler._setBlurredForTesting(false);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockNeedsReindexing).toHaveBeenCalledTimes(3);
    expect(mockIndexFile).toHaveBeenCalledTimes(3);
    expect(service.getWatcherStatus().pendingFiles).toBe(0);
    expect(service.getIndexerStats()).toEqual(
      expect.objectContaining({
        queueItemsEnqueued: 3,
        queueItemsProcessed: 3,
        queueItemsFailed: 0,
      })
    );
  });

  // Stage 4c (Opus-F4): cleanupStaleEntries must NOT bare-`fs.realpath` a
  // CLOUD-space indexed path (a residual main-thread hang vector on a dead mount) —
  // cloud paths are skipped + retained; only LOCAL paths get the realpath.
  it('cleanupStaleEntries does NOT fs.realpath a cloud-space path and RETAINS it (local paths unchanged)', async () => {
    const fsNode = await import('node:fs');
    const osNode = await import('node:os');
    const pathNode = await import('node:path');
    const scratch = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'cleanup-4c-'));
    const wsRoot = pathNode.join(scratch, 'workspace');
    fsNode.mkdirSync(wsRoot, { recursive: true });
    const cloudTarget = pathNode.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'General',
    );
    fsNode.symlinkSync(cloudTarget, pathNode.join(wsRoot, 'General'));

    // Configure the REAL containment map from the real symlink + a healthy stub
    // probe (so the cloud entry classifies as a cloud space, not 'local').
    const containment = await import('@core/services/cloudSpaceContainment');
    const probeModule = await import('@core/services/cloudLivenessProbe');
    probeModule.setCloudLivenessProbe({
      probeHealth: async () => 'healthy',
      getCachedVerdict: () => 'healthy',
    });
    containment.configureCloudSpaceContainment(wsRoot, [
      { name: 'General', path: 'General', type: 'other', isSymlink: true, createdAt: 0 },
    ]);

    // Indexed entries: one CLOUD (canonical-realpath form, the dominant stored form)
    // + one LOCAL.
    const cloudEntry = pathNode.join(cloudTarget, 'doc.md');
    const localEntry = pathNode.join(wsRoot, 'LocalSpace', 'local.md');
    mockGetIndexedPaths.mockReturnValue([cloudEntry, localEntry]);

    // Real removers wired so we can assert the cloud entry is NOT removed.
    const coordinator = await import('../indexRemovalCoordinator');
    coordinator.configureIndexRemovalCoordinator({
      removeSource: mockSourceMetadataRemoveSource,
      isSourcePath: mockSourceMetadataIsSourcePath,
      removeEntity: mockEntityMetadataRemoveEntity,
      removeFileFromIndex: mockRemoveFileFromIndex,
      removeFilesFromIndex: mockRemoveFilesFromIndex,
    });

    // The LOCAL entry's realpath ENOENTs (file gone) → it should be purged.
    mockFsRealpath.mockImplementation(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const service = await import('../fileWatcherService');
    await service.__cleanupStaleEntriesForTests(wsRoot);

    // The cloud entry was NEVER realpath'd (the hang vector).
    expect(mockFsRealpath).not.toHaveBeenCalledWith(cloudEntry);
    // The local entry WAS realpath'd (unchanged behaviour).
    expect(mockFsRealpath).toHaveBeenCalledWith(localEntry);
    // The cloud entry was NOT removed (retained); only the local (ENOENT) one is
    // in the batch delete.
    const removedBatch = mockRemoveFilesFromIndex.mock.calls.at(-1)?.[0] as string[] | undefined;
    expect(removedBatch).toContain(localEntry);
    expect(removedBatch).not.toContain(cloudEntry);

    containment.__resetCloudSpaceContainmentForTests();
    probeModule.__resetCloudLivenessProbeForTesting();
    fsNode.rmSync(scratch, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SYNTHESIS S4.3 (260619_cloud-symlink-indexing) — discoverWorkspaceNow(): the
  // forced, non-clearing re-walk the cloud periodic scheduler drives (R2). Pins the
  // headline R2 guarantees and the F1 ownership-scope hardening of the shared
  // background-discovery `inProgress` flag.
  // ───────────────────────────────────────────────────────────────────────────
  describe('discoverWorkspaceNow (S4.3 forced re-walk)', () => {
    it('re-walks via discoverFiles WITHOUT clearing the index, even when the skip heuristic would skip foreground rescan (R2)', async () => {
      // Existing index + a RECENT completed scan ⇒ startWatching would SKIP foreground
      // discovery AND skip scheduling a background pass — exactly the no-op case
      // discoverWorkspaceNow exists to bypass.
      mockGetScanCompletedAt.mockReturnValue(Date.now() - 60 * 1000); // 1 min ago: recent
      mockGetIndexStatus.mockReturnValue({
        indexedFiles: 42,
        pendingFiles: 0,
        isWatching: true,
        status: 'watching',
      });
      const { service } = await loadHarness();

      mockClearIndex.mockClear();
      mockIndexFile.mockClear();
      mockNeedsReindexing.mockClear();
      mockFsReaddir.mockResolvedValue([
        { name: 'recovered.md', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ]);

      await service.discoverWorkspaceNow();
      await vi.advanceTimersByTimeAsync(200);

      // (a) bypassed the skip heuristic: discovered despite recent scan + existing index.
      expect(mockNeedsReindexing).toHaveBeenCalledWith('/workspace/recovered.md');
      expect(mockIndexFile).toHaveBeenCalledWith('/workspace/recovered.md', '/workspace');
      // (b) NEVER cleared the index (retain last-known).
      expect(mockClearIndex).not.toHaveBeenCalled();
    });

    it('is a no-op when no workspace is being watched', async () => {
      const { service } = await loadHarness();
      await activeService!.stopWatching(); // clears state.workspacePath
      mockFsReaddir.mockClear();

      await service.discoverWorkspaceNow();

      expect(mockFsReaddir).not.toHaveBeenCalled();
    });

    it('the aborted prior run reaching its finally mid-flight does NOT strand the replacement out of batch-filtering (F1 ownership — red/green)', async () => {
      // True red/green for the F1 ownership scope. discoverWorkspaceNow cancels any
      // active background discovery and starts a replacement. We park BOTH runs in
      // readdir so the aborted prior run A's `finally` executes WHILE replacement B is
      // still in flight. With the bug (unconditional clear), A clears the shared
      // `backgroundDiscoveryInProgress` flag that B owns, so B's queued file hits
      // `enqueue`'s `!backgroundDiscoveryInProgress` branch → immediate
      // `startProcessing()` that drains it BEFORE `batchFilterQueue` (skipping the
      // mtime filter). With the fix, B still owns the flag, so its file is deferred to
      // `batchFilterQueue` and shows up in the "Starting batch mtime check" log.
      mockGetScanCompletedAt.mockReturnValue(Date.now() - 60 * 1000);
      mockGetIndexStatus.mockReturnValue({
        indexedFiles: 42,
        pendingFiles: 0,
        isWatching: true,
        status: 'watching',
      });
      const { service } = await loadHarness();

      mockLogger.info.mockClear();
      mockIndexFile.mockClear();
      const gateA = createDeferred<unknown[]>();
      const gateB = createDeferred<unknown[]>();
      // A's readdir hangs (A parks mid-walk); B's readdir hangs too (B parks mid-walk,
      // so A's finally runs while B is still active); then B's readdir resolves a file.
      mockFsReaddir
        .mockImplementationOnce(() => gateA.promise as Promise<never>)
        .mockImplementationOnce(() => gateB.promise as Promise<never>);

      const runA = service.discoverWorkspaceNow(); // owner=A, parked on gateA
      await vi.advanceTimersByTimeAsync(0);
      const runB = service.discoverWorkspaceNow(); // cancels A, owner=B, parked on gateB
      await vi.advanceTimersByTimeAsync(0);

      // A's finally executes WHILE B is parked in readdir.
      gateA.resolve([]);
      await runA.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // B finishes its walk and queues its discovered file.
      gateB.resolve([
        { name: 'recovered.md', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ]);
      await runB;
      await vi.advanceTimersByTimeAsync(200);

      // B's file went through batch mtime filtering (deferred), not premature drain.
      const batchLog = findLogCall(mockLogger.info, 'Starting batch mtime check');
      expect(batchLog?.[0]).toEqual(expect.objectContaining({ totalFiles: 1 }));
      expect(mockIndexFile).toHaveBeenCalledWith('/workspace/recovered.md', '/workspace');
    });
  });
});
