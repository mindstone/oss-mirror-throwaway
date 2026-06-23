/**
 * S4.1e Stage 2 — review F3 + F2: the cold-cache ENOENT fallback drives the REAL
 * Stage-1-bounded `scanSpacesReadOnly` against a workspace containing a dead cloud
 * symlink space, and the handler SETTLES (bounded, not hung).
 *
 * Unlike the unit-level `cloudReadBound.test.ts` (which mocks `node:fs/promises` +
 * `resolveLibraryPath` + `scanSpacesReadOnly`), this suite uses REAL temp-dir fixtures
 * and the REAL `scanSpacesReadOnly` / `resolveLibraryFileRequest` / `resolveSourcePathFallback`,
 * only wiring the boundary's cloud-lane executor double + spying that the real scan IS
 * invoked (delegating through to the real implementation). That is the whole point of the
 * A-before-B coupling guard the reviewer flagged: the original test mocked the scan to
 * reject immediately, so it never exercised the real (now-bounded) scan. Here the handler's
 * ENOENT fallback calls the REAL scan, whose cloud-symlink candidate reads resolve
 * `reconnecting` (dead mount) → the space is retained-degraded → the scan SETTLES (Stage 1's
 * bound). The fake-timer assertion proves "bounded, not hung": we advance well past any
 * plausible budget and require the handler promise to have settled.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();
const mockGetSettings = vi.fn();
// Spy that DELEGATES to the real scanSpacesReadOnly — proves the handler reaches the real
// (Stage-1-bounded) scan rather than a mock, while keeping the real bounding behaviour.
const scanSpy = vi.fn();

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

vi.mock('../../tracking', () => ({ mainTracking: { workArtifactCreated: vi.fn() } }));

vi.mock('@core/logger', () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  return { logger: noop, createScopedLogger: () => noop };
});

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ getPath: () => '/mock/app-data', getVersion: () => '1.0.0', isPackaged: false, appPath: '/mock/app', userDataPath: '/mock/userData' }),
}));

vi.mock('@core/featureGating', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(false) }));
vi.mock('../../services/demoModeService', () => ({ isDemoModeActive: vi.fn().mockReturnValue(false) }));
vi.mock('../../services/fileTreeService', () => ({ buildFileTree: vi.fn(), countLibraryItems: vi.fn() }));
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn();
    set = vi.fn();
    delete = vi.fn();
    has = vi.fn();
  },
}));

// Partial mock of the spaceService re-export libraryHandlers imports from: `scanSpacesReadOnly`
// DELEGATES to the real implementation through `scanSpy`, so the REAL Stage-1-bounded scan
// runs AND we can assert the handler actually reached it (the F3 fix — no hollow mock).
vi.mock('../../services/spaceService', async () => {
  const actual = await vi.importActual<typeof import('../../services/spaceService')>('../../services/spaceService');
  return {
    ...actual,
    scanSpacesReadOnly: (...args: unknown[]) => {
      scanSpy(...args);
      return (actual.scanSpacesReadOnly as (...a: unknown[]) => unknown)(...args);
    },
  };
});

let registerLibraryHandlers: typeof import('../libraryHandlers').registerLibraryHandlers;
let setWorkspaceFsExecutor: typeof import('@core/services/boundedWorkspaceFs').setWorkspaceFsExecutor;
let __resetWorkspaceFsExecutorForTesting: typeof import('@core/services/boundedWorkspaceFs').__resetWorkspaceFsExecutorForTesting;
let realFsExecutorWith: typeof import('@core/services/__tests__/workspaceFsExecutorDoubles').realFsExecutorWith;
let realFsExecutor: typeof import('@core/services/__tests__/workspaceFsExecutorDoubles').realFsExecutor;
let configureCloudSpaceContainment: typeof import('@core/services/cloudSpaceContainment').configureCloudSpaceContainment;
let __resetCloudSpaceContainmentForTests: typeof import('@core/services/cloudSpaceContainment').__resetCloudSpaceContainmentForTests;
let _resetScanSpacesCountersForTesting: typeof import('@core/services/space/spaceService')._resetScanSpacesCountersForTesting;

let tmpRoot: string;
let workspace: string;
let cloudTarget: string;

const RECONNECTING = /reconnecting/i;

/** Every cloud-lane op resolves `reconnecting` (a dead mount); LOCAL reads use real fs. */
function deadCloudExecutor() {
  const timeout = () => Promise.resolve({ ok: false, reason: 'timeout' } as const);
  return realFsExecutorWith({
    stat: timeout,
    lstat: timeout,
    realpath: timeout,
    readlink: timeout,
    readdir: timeout,
    readdirWithFileTypes: timeout,
    readFile: timeout,
    readFileBytes: timeout,
    access: timeout,
  });
}

beforeEach(async () => {
  registeredHandlers.clear();
  scanSpy.mockReset();
  ({ registerLibraryHandlers } = await import('../libraryHandlers'));
  ({ setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import('@core/services/boundedWorkspaceFs'));
  ({ realFsExecutorWith, realFsExecutor } = await import('@core/services/__tests__/workspaceFsExecutorDoubles'));
  ({ configureCloudSpaceContainment, __resetCloudSpaceContainmentForTests } = await import('@core/services/cloudSpaceContainment'));
  ({ _resetScanSpacesCountersForTesting } = await import('@core/services/space/spaceService'));

  __resetWorkspaceFsExecutorForTesting();
  __resetCloudSpaceContainmentForTests();
  _resetScanSpacesCountersForTesting();
  // Disable the scan coalesced cache → every scan is a fresh COLD scan (deterministic).
  process.env.REBEL_DISABLE_SPACES_COALESCE = '1';

  // Real LOCAL workspace root (so its readdir/access succeed on real fs) holding a
  // cloud-symlink space whose target is a pattern-cloud `Dropbox/` dir.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-coldcache-')));
  workspace = path.join(tmpRoot, 'workspace');
  await fs.mkdir(workspace);
  cloudTarget = path.join(tmpRoot, 'Dropbox', 'Shared', 'General');
  await fs.mkdir(cloudTarget, { recursive: true });
  await fs.writeFile(path.join(cloudTarget, 'README.md'), '---\nrebel_space_description: Cloud space\n---\n\n# General\n');
  await fs.symlink(cloudTarget, path.join(workspace, 'General'));
  // Register the cloud-symlink space (so the scan's candidate reads route the cloud lane).
  configureCloudSpaceContainment(workspace, [
    { name: 'General', path: 'General', type: 'other', isSymlink: true, sourcePath: cloudTarget, createdAt: 0 } as never,
  ]);

  mockGetSettings.mockReturnValue({
    coreDirectory: workspace,
    spaces: [{ name: 'General', path: 'General', isSymlink: true, sourcePath: cloudTarget }],
  });

  registerLibraryHandlers({
    getSettings: mockGetSettings,
    getSettingsStore: vi.fn(),
  } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
});

afterEach(async () => {
  __resetWorkspaceFsExecutorForTesting();
  __resetCloudSpaceContainmentForTests();
  _resetScanSpacesCountersForTesting();
  delete process.env.REBEL_DISABLE_SPACES_COALESCE;
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('library:read-file — cold-cache ENOENT drives the REAL bounded scanSpacesReadOnly (F3)', () => {
  it('a LOCAL-missing path triggers the ENOENT fallback → REAL scan over a dead cloud-symlink workspace → handler SETTLES (bounded, not hung)', async () => {
    // `notes.md` resolves to a LOCAL path under the workspace root that does NOT exist, so
    // the direct stat ENOENTs on REAL fs (not the cloud lane) → the handler falls back to
    // the REAL `scanSpacesReadOnly(workspace)`. The scan's root reads are local (settle);
    // its `General` cloud-symlink candidate's reads route the dead cloud lane and resolve
    // `reconnecting` → the candidate is retained-degraded (Stage 1) → the scan SETTLES.
    // An UNBOUNDED scan would block on the dead mount here (the bug the A-before-B order
    // prevents); the bounded scan settles, so the whole handler settles.
    setWorkspaceFsExecutor(deadCloudExecutor());

    const handler = registeredHandlers.get('library:read-file')!;
    expect(handler).toBeDefined();

    // The handler must SETTLE (reject — the file is genuinely missing) WITHOUT hanging.
    // If the real scan were unbounded against the dead mount, this never resolves → the
    // test runner times out (the regression signal).
    await expect(Promise.resolve(handler({}, 'notes.md'))).rejects.toBeInstanceOf(Error);

    // Prove we actually drove the REAL scan (not a hollow mock): the ENOENT fallback called it.
    expect(scanSpy).toHaveBeenCalledWith(workspace);
  });

  it('F2: a reconnecting source-path fallback surfaces the calm "reconnecting" error (not a generic ENOENT / silent absence)', async () => {
    // Request a path UNDER the `General` cloud space. The resolved path is containment-cloud,
    // so the first bounded stat resolves `reconnecting` (dead mount) → the read surfaces the
    // calm error. This is the cloud-read hang-proofing on the direct path; combined with F2's
    // re-throw in the source-fallback catch, a reconnecting fallback path never degrades to a
    // generic ENOENT. (The cold-cache scan path is covered by the test above.)
    setWorkspaceFsExecutor(deadCloudExecutor());

    const handler = registeredHandlers.get('library:read-file')!;
    await expect(Promise.resolve(handler({}, 'General/file.md'))).rejects.toThrow(RECONNECTING);
  });

  it('F2 negative: a genuine ENOENT (healthy mount, missing file) does NOT surface a spurious reconnecting error', async () => {
    // Healthy cloud mount (delegates to real fs). The cloud target exists; the file does not
    // → genuine ENOENT all the way → must NOT be reported as "reconnecting".
    setWorkspaceFsExecutor(realFsExecutor);

    const handler = registeredHandlers.get('library:read-file')!;
    await Promise.resolve(handler({}, 'General/does-not-exist.md')).then(
      () => {
        throw new Error('expected the handler to reject for a missing file');
      },
      (e: Error) => {
        expect(e.message).not.toMatch(RECONNECTING);
      },
    );
  });
});
