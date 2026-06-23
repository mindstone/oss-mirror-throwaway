/**
 * S4.1e — library read-handler cloud-read hang-proofing via the universal
 * `boundedWorkspaceFs` boundary (replaces the retired bespoke `runCloudBoundedRead`
 * whole-op wrapper + 2-slot cap).
 *
 * Clicking a degraded-cloud-space search result must NOT hang the main thread on a
 * dead FUSE mount. The 3 read handlers now route every fs read through `workspaceFs`,
 * which sends a cloud-classified path (here a `~/Library/CloudStorage/…` path — the
 * real `detectCloudStorage` pattern classifier flags it, so `cloudLaneOptionForPath`
 * forces the cloud lane) to the killable child-process pool. We drive the cloud lane
 * with a wired executor double: a DEAD-mount executor (every op → `reconnecting`) for
 * the hang-proofing cases, and assert the handler surfaces the calm "reconnecting"
 * error (read-file/-base64) or the `{exists:false}` degrade (stat-file) — never hangs.
 * A LOCAL read takes the boundary's bare-`node:fs/promises` lane (mocked here) and is
 * unaffected.
 *
 * The pool's `MAX_INFLIGHT=8` global cap + kill-on-timeout now provides the
 * slot-starvation protection the old `MAX_CONCURRENT_CLOUD_READS=2` semaphore did (and
 * *reclaims* a wedged worker instead of holding a slot) — that pool behaviour is tested
 * in `cloudFsExecutorService.test.ts` (Inv 6), so the old hold-to-settlement/slot-reclaim
 * tests (which exercised the deleted machinery) are not re-pointed here.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();
const mockGetSettings = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
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

vi.mock('../../tracking', () => ({ mainTracking: { workArtifactCreated: vi.fn() } }));

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
      const root = path.resolve(coreDirectory);
      const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
      return { root, resolved };
    }),
    tryConvertToWorkspacePath: vi.fn((p: string) => p),
  };
});

// The boundary's LOCAL lane imports `node:fs/promises` directly — mock it so a LOCAL
// read is interceptable. `toWorkspaceStat` calls `.isFile()` on the returned Stats, so
// the mock returns a method (matching real fs.Stats), NOT a property.
vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...args: unknown[]) => mockStat(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
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
  getPlatformConfig: () => ({ getPath: () => '/mock/app-data', getVersion: () => '1.0.0' }),
}));

vi.mock('@core/featureGating', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(false) }));

vi.mock('../../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: (err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EMFILE' || code === 'ENFILE';
  },
  withRetryOnEmfile: async <T>(fn: () => Promise<T>) => fn(),
}));

// `scanSpacesReadOnly` is the ENOENT-fallback hang vector (now bounded in Stage 1). We
// mock it so the cold-cache regression test can simulate a dead cloud root: a scan that
// surfaces the calm "reconnecting" error (what the now-bounded scan does on a dead mount)
// must propagate as the handler's calm error within the bound, never hang.
vi.mock('@core/services/space/spaceService', async () => {
  const actual = await vi.importActual<typeof import('@core/services/space/spaceService')>(
    '@core/services/space/spaceService',
  );
  return {
    ...actual,
    scanSpacesReadOnly: (...args: unknown[]) => mockScanSpacesReadOnly(...args),
  };
});

vi.mock('@core/utils/portablePath', () => ({
  toPortablePath: (p: string) => p,
  relativePortablePath: (p: string) => p,
}));

vi.mock('../../services/demoModeService', () => ({ isDemoModeActive: vi.fn().mockReturnValue(false) }));
vi.mock('../../services/fileTreeService', () => ({ buildFileTree: vi.fn(), countLibraryItems: vi.fn() }));

let registerLibraryHandlers: typeof import('../libraryHandlers').registerLibraryHandlers;
let setWorkspaceFsExecutor: typeof import('@core/services/boundedWorkspaceFs').setWorkspaceFsExecutor;
let __resetWorkspaceFsExecutorForTesting: typeof import('@core/services/boundedWorkspaceFs').__resetWorkspaceFsExecutorForTesting;
let deadMountExecutor: typeof import('@core/services/__tests__/workspaceFsExecutorDoubles').deadMountExecutor;

const RECONNECTING = /reconnecting/i;

beforeEach(async () => {
  registeredHandlers.clear();
  mockStat.mockReset();
  mockReadFile.mockReset();
  mockScanSpacesReadOnly.mockReset();
  mockScanSpacesReadOnly.mockResolvedValue([]);
  ({ registerLibraryHandlers } = await import('../libraryHandlers'));
  ({ setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import('@core/services/boundedWorkspaceFs'));
  ({ deadMountExecutor } = await import('@core/services/__tests__/workspaceFsExecutorDoubles'));
  __resetWorkspaceFsExecutorForTesting();
  registerLibraryHandlers({
    getSettings: mockGetSettings,
    getSettingsStore: vi.fn(),
  } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
});

afterEach(() => {
  __resetWorkspaceFsExecutorForTesting();
  vi.restoreAllMocks();
});

describe('library:read-file — S4.1e cloud-read hang-proofing (boundary)', () => {
  const cloudCore = '/Users/test/Library/CloudStorage/GoogleDrive-jane@example.com/My Drive/ws';

  it('a DEAD cloud read is BOUNDED — rejects with a calm "reconnecting" error, never hangs', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: cloudCore });
    // Dead mount: every cloud-lane op resolves `reconnecting` (no fake timers needed —
    // the executor double settles synchronously). The handler's `boundedStat` throws the
    // calm error; the handler surfaces it.
    setWorkspaceFsExecutor(deadMountExecutor);

    const handler = registeredHandlers.get('library:read-file')!;
    expect(handler).toBeDefined();

    await expect(Promise.resolve(handler({}, 'doc.md'))).rejects.toThrow(RECONNECTING);
    // Must NOT leak the raw path / email.
    await Promise.resolve(handler({}, 'doc.md')).catch((e: Error) => {
      expect(e.message).not.toContain('jane@example.com');
      expect(e.message).not.toContain('doc.md');
    });
  });

  it('a LOCAL read is unaffected (bare-fs lane) and returns content', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: '/Users/test/Documents/ws' });
    // LOCAL lane → node:fs/promises mock. `toWorkspaceStat` calls `.isFile()`.
    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: 123, ctimeMs: 123, size: 5 });
    mockReadFile.mockResolvedValue('hello');

    const handler = registeredHandlers.get('library:read-file')!;
    const result = (await handler({}, 'doc.md')) as { content: string; updatedAt: number };
    expect(result.content).toBe('hello');
    expect(result.updatedAt).toBe(123);
  });

  it('F2 (fallback-path reconnecting): direct stat ENOENTs → real source-path fallback to a dead cloud path → calm "reconnecting" error, NOT a generic ENOENT', async () => {
    // The workspace symlink is broken (direct stat ENOENTs) but the space has a sourcePath
    // pointing at a cloud target; the handler's ENOENT branch runs the (real)
    // `resolveSourcePathFallback`, which maps the path to the cloud sourcePath, then
    // `boundedStat(fallbackPath)` on that DEAD cloud path resolves `reconnecting`. Before
    // the F2 fix the fallback's bare `catch {}` swallowed that → the read fell through to a
    // generic ENOENT, hiding the reconnecting cause. Now it is re-thrown.
    const wsRoot = '/Users/test/Documents/ws';
    const cloudSource = '/Users/test/Library/CloudStorage/GoogleDrive-jane@example.com/My Drive/General';
    mockGetSettings.mockReturnValue({ coreDirectory: wsRoot });
    // The real resolveSourcePathFallback consumes the scan result; give it a space whose
    // workspace path prefixes the request and whose sourcePath is the cloud target.
    mockScanSpacesReadOnly.mockResolvedValue([
      { name: 'General', path: 'General', absolutePath: `${wsRoot}/General`, sourcePath: cloudSource, isSymlink: true, hasReadme: true },
    ]);
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // LOCAL workspace stats ENOENT; the cloud sourcePath stat reconnects (dead mount).
    setWorkspaceFsExecutor({
      ...deadMountExecutor,
      stat: (p: string) =>
        p.includes('CloudStorage')
          ? Promise.resolve({ ok: false, reason: 'timeout' })
          : Promise.resolve({ ok: false, reason: 'error', error: enoent }),
    });
    // Direct LOCAL stat path also ENOENTs via node:fs/promises mock (probe stats).
    mockStat.mockRejectedValue(enoent);

    const handler = registeredHandlers.get('library:read-file')!;
    await expect(Promise.resolve(handler({}, 'General/missing.md'))).rejects.toThrow(RECONNECTING);
  });
});

describe('library:stat-file — S4.1e cloud degrade', () => {
  const cloudCore = '/Users/test/Library/CloudStorage/GoogleDrive-jane@example.com/My Drive/ws';

  it('a DEAD cloud stat DEGRADES to {exists:false, mtimeMs:null, size:null} (never throws, never hangs)', async () => {
    mockGetSettings.mockReturnValue({ coreDirectory: cloudCore });
    setWorkspaceFsExecutor(deadMountExecutor);

    const handler = registeredHandlers.get('library:stat-file')!;
    const result = (await handler({}, 'image.png')) as { exists: boolean; mtimeMs: number | null; size: number | null };
    expect(result).toEqual({ exists: false, mtimeMs: null, size: null });
  });
});
