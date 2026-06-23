import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Reusable fake chokidar watcher that captures handlers and lets tests fire them
class FakeWatcher extends EventEmitter {
  public closed = false;
  public registered: string[] = [];
  public on(event: string, listener: (...args: unknown[]) => void): this {
    this.registered.push(event);
    return super.on(event, listener);
  }
  public getWatched(): Record<string, string[]> {
    return {};
  }
  public async close(): Promise<void> {
    this.closed = true;
  }
}

let currentWatcher: FakeWatcher | null = null;

 
vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    currentWatcher = new FakeWatcher();
    return currentWatcher;
  }),
}));


/**
 * An `EINVAL`-on-not-a-symlink sentinel used by the readlink mock to signal that
 * a path is a real (non-symlink) file/dir — i.e. the chain bottomed out locally.
 * Mirrors what `readlinkSync` throws on a non-symlink.
 */
function makeEinval(): NodeJS.ErrnoException {
  const err = new Error('EINVAL: invalid argument, readlink') as NodeJS.ErrnoException;
  err.code = 'EINVAL';
  return err;
}

const {
  readdirSyncMock,
  readlinkSyncMock,
  statSyncMock,
  statAsyncMock,
  detectCloudStorageMock,
  detectInPlaceCloudDocumentsMock,
  getTimeoutForPathMock,
  joinImplRef,
} = vi.hoisted(() => ({
  readdirSyncMock: vi.fn<(p: string, opts?: unknown) => Array<{ name: string; isSymbolicLink: () => boolean }>>(() => []),
  // Default: every readlink throws EINVAL (no symlink anywhere) so the chain
  // classifier treats everything as a non-cloud local terminus. Cloud tests
  // override this to return the cloud-mount target for the symlink under test.
  readlinkSyncMock: vi.fn<(p: string) => string>(() => {
    throw makeEinval();
  }),
  // Synchronous root pre-validate (LOCAL path). Default: a healthy directory.
  statSyncMock: vi.fn<(p: string) => { isDirectory: () => boolean }>(
    () => ({ isDirectory: () => true }),
  ),
  // Async root pre-validate (CLOUD path). Default: a healthy directory, resolved
  // immediately. Cloud-root tests override this to a never-resolving promise to
  // reproduce a dead mount.
  statAsyncMock: vi.fn<(p: string) => Promise<{ isDirectory: () => boolean }>>(
    async () => ({ isDirectory: () => true }),
  ),
  detectCloudStorageMock: vi.fn<(p: string) => { isCloud: boolean; provider?: string }>(
    () => ({ isCloud: false }),
  ),
  // Default: not an in-place iCloud Documents/Desktop root (LOCAL path).
  detectInPlaceCloudDocumentsMock: vi.fn<(p: string) => boolean>(() => false),
  getTimeoutForPathMock: vi.fn<(p: string) => number>(() => 5000),
  // Swappable join: defaults to the real POSIX join; the Windows regression
  // test points it at `path.win32.join` to reproduce backslash paths on the
  // (POSIX) CI host. dirname/isAbsolute/resolve are left real.
  joinImplRef: { current: null as null | ((...parts: string[]) => string) },
}));
vi.mock('node:fs', () => ({
  statSync: (p: string) => statSyncMock(p),
  readdirSync: (p: string, opts?: unknown) => readdirSyncMock(p, opts),
  readlinkSync: (p: string) => readlinkSyncMock(p),
}));
vi.mock('node:fs/promises', () => ({
  stat: (p: string) => statAsyncMock(p),
}));
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    default: actual,
    join: (...parts: string[]) => (joinImplRef.current ?? actual.join)(...parts),
  };
});


vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  // boundedWorkspaceFs (now transitively loaded via safeWalkDirectory — S4.1a) calls
  // createScopedLogger at module init; the mock must export it or collection fails.
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// NOTE: the mock path is relative to THIS test file. The SUT
// (src/main/services/workspaceWatcherService.ts) imports
// '../utils/cloudStorageUtils' → src/main/utils/cloudStorageUtils. From here
// (src/main/services/__tests__/) that same module is '../../utils/...'. A
// previous '../utils/...' here resolved to the nonexistent
// src/main/services/utils/... so the mock was DEAD and the cloud tests only
// passed because their target values happened to match the real detector
// regexes. With the corrected path these mocks are live, so every cloud test
// must configure detectCloudStorageMock for its cloud target.
vi.mock('../../utils/cloudStorageUtils', () => ({
  detectCloudStorage: (p: string) => detectCloudStorageMock(p),
  detectInPlaceCloudDocuments: (p: string) => detectInPlaceCloudDocumentsMock(p),
  getTimeoutForPath: (p: string) => getTimeoutForPathMock(p),
}));

const captureExceptionMock = vi.fn();
const addBreadcrumbMock = vi.fn();

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureException: captureExceptionMock, addBreadcrumb: addBreadcrumbMock }),
}));

const { workspaceWatcherService } = await import('../workspaceWatcherService');
const { watch } = await import('chokidar');
const { logger } = await import('@core/logger');
// Stage 7 de-admission uses the REAL admission flag + liveness probe seam (these
// modules are NOT mocked here). `mintFirstCloudHopTargetSync` keys the verdict off
// the readlink chain (the test's `readlinkSyncMock`), and the chain's cloud check
// uses the REAL `@core` detector — so cloud targets must be genuinely
// cloud-classified paths (e.g. `~/Library/CloudStorage/GoogleDrive-…`).
const { setCloudSymlinkIndexingEnabled, __resetCloudSymlinkIndexingForTests } = await import(
  '@core/services/cloudSymlinkIndexing'
);
const { setCloudLivenessProbe, __resetCloudLivenessProbeForTesting } = await import(
  '@core/services/cloudLivenessProbe'
);

type IgnorePatternMatcher = string | RegExp | ((path: string, stats?: unknown) => boolean);


const anymatch = require('anymatch') as (
  matchers: IgnorePatternMatcher[] | IgnorePatternMatcher,
  testPath: string | [string, unknown],
) => boolean;

/**
 * A minimal lstat-shaped stub for driving the matcher's NESTED-symlink branch.
 * chokidar watches with `{ alwaysStat: true, lstat: true }`, so the matcher
 * receives an lstat whose `isSymbolicLink()` is true for a symlink at any depth.
 */
function symlinkStats(): { isSymbolicLink: () => boolean } {
  return { isSymbolicLink: () => true };
}

/**
 * Drive anymatch the way chokidar's `filterDir`/`filterPath` do for a symlink:
 * pass `[candidatePath, stats]` so the function matcher receives the lstat as its
 * 2nd arg (anymatch `matchPatterns` calls `pattern(...[path].concat(rest))`).
 */
function matchWithStats(
  matchers: IgnorePatternMatcher[],
  candidatePath: string,
  stats: unknown,
): boolean {
  return anymatch(matchers, [candidatePath, stats]);
}

function getWatchOptions(): Record<string, unknown> {
  const watchMock = watch as unknown as {
    mock: { calls: Array<[string, Record<string, unknown>]> };
  };
  const latestCall = watchMock.mock.calls.at(-1);
  if (!latestCall) {
    throw new Error('Expected chokidar.watch() to be called');
  }
  return latestCall[1] ?? {};
}

function getIgnoredMatchers(): IgnorePatternMatcher[] {
  const ignored = getWatchOptions().ignored as
    | IgnorePatternMatcher[]
    | IgnorePatternMatcher
    | undefined;
  if (!ignored) {
    throw new Error('Expected chokidar.watch() to receive ignored matchers');
  }

  return Array.isArray(ignored) ? ignored : [ignored];
}

function makeFsError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: ${syscall === 'lstat' ? 'invalid argument' : 'name too long'}, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

describe('workspaceWatcherService — REBEL-1HK / REBEL-56E watcher hardening', () => {
  beforeEach(() => {
    currentWatcher = null;
    vi.clearAllMocks();
    workspaceWatcherService.removeAllListeners();
  });

  afterEach(async () => {
    await workspaceWatcherService.stop();
    workspaceWatcherService.removeAllListeners();
  });

  it('keeps followSymlinks enabled (symlink-following is a product feature, not incidental)', () => {
    // Stage 4a investigation conclusion: users symlink external local folders
    // into their workspace and rely on the watcher to detect CHANGES inside them
    // (discoverFiles only does the initial scan). So we harden the cloud-symlink
    // exclusion matcher rather than disabling followSymlinks. (We deliberately do
    // NOT force useFsEvents:false: readdirp realpaths a symlink before chokidar's
    // ignore hook on every backend, so switching backends wouldn't close the
    // residual realpath gap and would add macOS fs.watch risk — see the
    // implementer report.)
    workspaceWatcherService.start('/fake/workspace');
    expect(getWatchOptions().followSymlinks).toBe(true);
  });

  it('does not throw when chokidar fires ENAMETOOLONG with no error listener (REBEL-56E)', () => {
    workspaceWatcherService.start('/fake/workspace');
    expect(currentWatcher).not.toBeNull();
    expect(workspaceWatcherService.listenerCount('error')).toBe(0);

    const fatalError = makeFsError(
      'ENAMETOOLONG',
      'stat',
      '/fake/workspace/'.padEnd(2000, 'a/b/'),
    );

    // Pre-fix this would throw a fatal "Unhandled 'error' event" because
    // EventEmitter throws on emit('error', ...) when no listener is registered.
    expect(() => currentWatcher?.emit('error', fatalError)).not.toThrow();
  });

  it('does not let a slow old stop() clobber the watcher a concurrent start() installed (DI-23 F2 race)', async () => {
    workspaceWatcherService.start('/fake/a');
    const watcherA = currentWatcher;
    expect(watcherA).not.toBeNull();
    expect(workspaceWatcherService.isWatching()).toBe(true);

    // Gate A.close() so the teardown suspends mid-flight, opening the race window.
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    watcherA!.close = vi.fn(async () => {
      await closeGate;
      watcherA!.closed = true;
    });

    // Reconfigure to B. start()'s own fireAndForget(this.stop()) awaits the gated
    // A.close(), then start() installs watcher B + currentDirectory '/fake/b'.
    workspaceWatcherService.start('/fake/b');
    const watcherB = currentWatcher;
    expect(watcherB).not.toBe(watcherA);
    expect(workspaceWatcherService.getCurrentDirectory()).toBe('/fake/b');

    // Old stop() (of A) now resolves and must NOT null the freshly-installed B state.
    releaseClose();
    await new Promise((r) => setTimeout(r, 0));

    expect(workspaceWatcherService.isWatching()).toBe(true);
    expect(workspaceWatcherService.getCurrentDirectory()).toBe('/fake/b');
  });

  it('ignores paths longer than the safe walk path-length cap', () => {
    workspaceWatcherService.start('/fake/workspace');

    const ignoredMatchers = getIgnoredMatchers();
    const longPath = `/fake/workspace/${'loop/'.repeat(180)}notes.md`;
    expect(longPath.length).toBeGreaterThan(900);

    expect(anymatch(ignoredMatchers, longPath)).toBe(true);
  });

  it('does not ignore normal-length workspace paths', () => {
    workspaceWatcherService.start('/fake/workspace');

    const ignoredMatchers = getIgnoredMatchers();
    const normalPath = `/fake/workspace/${'notes/'.repeat(25)}journal.md`;
    expect(normalPath.length).toBeLessThan(200);

    expect(anymatch(ignoredMatchers, normalPath)).toBe(false);
  });

  it('still ignores .rebel-maintenance.lock.json paths', () => {
    workspaceWatcherService.start('/fake/workspace');

    const ignoredMatchers = getIgnoredMatchers();
    const lockPath = '/fake/workspace/Documents/Mindstone Rebel/.rebel-maintenance.lock.json';

    expect(anymatch(ignoredMatchers, lockPath)).toBe(true);
  });

  it('logs the path-length cap warning once per offending parent directory', () => {
    workspaceWatcherService.start('/fake/workspace');
    const ignoredMatchers = getIgnoredMatchers();

    const longParent = `/fake/workspace/${'loop/'.repeat(180)}`;
    const firstOffender = `${longParent}first.md`;
    const secondOffender = `${longParent}second.md`;

    expect(anymatch(ignoredMatchers, firstOffender)).toBe(true);
    expect(anymatch(ignoredMatchers, secondOffender)).toBe(true);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ capped: true, directory: expect.any(String) }),
      'workspace watcher path-length cap fired (recursive loop suspected)',
    );
  });

  it('does not throw when chokidar fires EINVAL with no error listener (REBEL-1HK)', () => {
    workspaceWatcherService.start('/fake/workspace');
    expect(workspaceWatcherService.listenerCount('error')).toBe(0);

    const einvalError = makeFsError(
      'EINVAL',
      'lstat',
      'C:\\Users\\test\\Documents\\Mindstone Rebel\\Memories\\.rebel-maintenance.lock.json',
    );

    expect(() => currentWatcher?.emit('error', einvalError)).not.toThrow();
  });

  it('does not throw when chokidar fires UNKNOWN with no error listener', () => {
    workspaceWatcherService.start('/fake/workspace');
    expect(workspaceWatcherService.listenerCount('error')).toBe(0);

    const unknownError = makeFsError(
      'UNKNOWN',
      'stat',
      'C:\\Users\\test\\Documents\\Mindstone Rebel\\Memories',
    );

    expect(() => currentWatcher?.emit('error', unknownError)).not.toThrow();
  });

  it('does propagate the error to subscribers when an error listener IS registered', () => {
    const received: NodeJS.ErrnoException[] = [];
    workspaceWatcherService.on('error', (err) => received.push(err as NodeJS.ErrnoException));

    workspaceWatcherService.start('/fake/workspace');
    expect(workspaceWatcherService.listenerCount('error')).toBe(1);

    const err = makeFsError('ENAMETOOLONG', 'stat', '/fake/path');
    currentWatcher?.emit('error', err);

    expect(received).toHaveLength(1);
    expect(received[0].code).toBe('ENAMETOOLONG');
  });

  it('still re-emits ENOSPC and EMFILE through the same listenerCount guard', () => {
    const received: NodeJS.ErrnoException[] = [];
    workspaceWatcherService.on('error', (err) => received.push(err as NodeJS.ErrnoException));

    workspaceWatcherService.start('/fake/workspace');

    const enospcErr = makeFsError('ENOSPC', 'inotify_add_watch', '/fake/path');
    const emfileErr = makeFsError('EMFILE', 'open', '/fake/path');

    currentWatcher?.emit('error', enospcErr);
    currentWatcher?.emit('error', emfileErr);

    expect(received.map(e => e.code)).toEqual(['ENOSPC', 'EMFILE']);
  });

  it('does not Sentry-capture known-transient codes (ENAMETOOLONG/EINVAL/UNKNOWN/ENOENT)', () => {
    workspaceWatcherService.start('/fake/workspace');

    for (const code of ['ENAMETOOLONG', 'EINVAL', 'UNKNOWN', 'ENOENT']) {
      currentWatcher?.emit('error', makeFsError(code, 'lstat', '/fake/path'));
    }

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does Sentry-capture novel error codes with code tag and dedupe-friendly fingerprint', () => {
    workspaceWatcherService.start('/fake/workspace');

    const novelError = makeFsError('EWHATEVER', 'lstat', '/fake/path');
    currentWatcher?.emit('error', novelError);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedErr, options] = captureExceptionMock.mock.calls[0];
    expect(capturedErr).toBe(novelError);
    expect(options).toMatchObject({
      level: 'warning',
      tags: { component: 'workspaceWatcher', code: 'EWHATEVER' },
      extra: { directory: '/fake/workspace' },
      fingerprint: ['workspaceWatcher', 'watcherError', 'EWHATEVER'],
    });
  });

  it('does Sentry-capture code-less errors with NO_CODE sentinel (regression guard)', () => {
    workspaceWatcherService.start('/fake/workspace');

    const codeLessError = new Error('chokidar internal stream failure') as NodeJS.ErrnoException;
    currentWatcher?.emit('error', codeLessError);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, options] = captureExceptionMock.mock.calls[0];
    expect(options).toMatchObject({
      level: 'warning',
      tags: { component: 'workspaceWatcher', code: 'NO_CODE' },
      fingerprint: ['workspaceWatcher', 'watcherError', 'NO_CODE'],
    });
  });
});

describe('workspaceWatcherService — RC-1 cloud-mount symlink exclusion', () => {
  beforeEach(() => {
    currentWatcher = null;
    vi.clearAllMocks();
    readdirSyncMock.mockReturnValue([]);
    // Default: nothing is a symlink (every readlink reports EINVAL).
    readlinkSyncMock.mockImplementation(() => {
      throw makeEinval();
    });
    detectCloudStorageMock.mockReturnValue({ isCloud: false });
    joinImplRef.current = null; // real POSIX join by default
    workspaceWatcherService.removeAllListeners();
  });

  afterEach(() => {
    joinImplRef.current = null;
  });

  afterEach(async () => {
    await workspaceWatcherService.stop();
    workspaceWatcherService.removeAllListeners();
  });

  it('excludes a cloud-mount symlink (and its subtree) but keeps a local outside-workspace symlink watched', () => {
    const workspace = '/fake/workspace';
    const cloudTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/Company Memories';
    // A non-cloud outside-workspace symlink that ISN'T already in
    // WORKSPACE_IGNORE_PATTERNS (rebel-system is, for UI-refresh reasons). This
    // proves the new cloud-exclusion does NOT over-broaden to "all symlinks".
    const localProjectTarget = '/Users/test/Projects/shared-notes';

    readdirSyncMock.mockReturnValue([
      { name: 'Company Memories', isSymbolicLink: () => true },
      { name: 'Shared Notes', isSymbolicLink: () => true },
      { name: 'local-notes', isSymbolicLink: () => false },
    ]);
    // readlink (NOT realpath — we must never touch the dead target): the symlink
    // points straight at its target; the target itself is a real dir (EINVAL).
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('Company Memories')) return cloudTarget;
      if (p.endsWith('Shared Notes')) return localProjectTarget;
      throw makeEinval();
    });
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);

    const ignoredMatchers = getIgnoredMatchers();

    // The cloud symlink itself and everything under it are excluded...
    expect(anymatch(ignoredMatchers, `${workspace}/Company Memories`)).toBe(true);
    expect(anymatch(ignoredMatchers, `${workspace}/Company Memories/sub/file.md`)).toBe(true);
    // ...but the non-cloud local symlink is STILL watched (carve-out works).
    expect(anymatch(ignoredMatchers, `${workspace}/Shared Notes`)).toBe(false);
    expect(anymatch(ignoredMatchers, `${workspace}/Shared Notes/today.md`)).toBe(false);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ entryName: 'Company Memories' }),
      'Workspace watcher: excluding cloud/unclassifiable top-level symlink target from watch',
    );
  });

  it('adds no cloud exclusions when the workspace has no cloud symlinks', () => {
    readdirSyncMock.mockReturnValue([
      { name: 'Shared Notes', isSymbolicLink: () => true },
    ]);
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('Shared Notes')) return '/Users/test/Projects/shared-notes';
      throw makeEinval();
    });

    workspaceWatcherService.start('/fake/workspace');

    const ignoredMatchers = getIgnoredMatchers();
    expect(anymatch(ignoredMatchers, '/fake/workspace/Shared Notes')).toBe(false);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Workspace watcher: excluding cloud/unclassifiable top-level symlink target from watch',
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // Stage 4a (260619_turn-hang-bugmode): NESTED-symlink + fail-CLOSED coverage.
  // These are the red→green regression tests for the root-cause fix. The
  // pre-fix matcher was TOP-LEVEL-ONLY and FAILED OPEN, so a cloud symlink one
  // level down (or a symlink we couldn't classify) was followed by chokidar
  // into the dead mount → libuv pool exhaustion → turn hang.
  // ────────────────────────────────────────────────────────────────────────

  it('excludes a NESTED cloud symlink discovered at descent time (root-cause regression)', () => {
    const workspace = '/fake/workspace';
    // The cloud symlink lives one level DOWN — the top-level precompute never
    // sees it. Pre-fix the matcher had no `stats` branch, so this was followed.
    const nestedSymlink = `${workspace}/Projects/Acme/DriveLink`;
    const cloudTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/Acme';

    // Top-level has no symlinks at all.
    readdirSyncMock.mockReturnValue([
      { name: 'Projects', isSymbolicLink: () => false },
    ]);
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p === nestedSymlink) return cloudTarget;
      throw makeEinval();
    });
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);
    const ignoredMatchers = getIgnoredMatchers();

    // Without stats (a plain candidate) the nested branch can't fire — proves we
    // only do readlink work for actual symlinks.
    expect(anymatch(ignoredMatchers, `${workspace}/Projects/Acme/note.md`)).toBe(false);

    // chokidar tests the symlink dir WITH its lstat → nested branch fires →
    // excluded, and its subtree is memoised so descendants match by string.
    expect(matchWithStats(ignoredMatchers, nestedSymlink, symlinkStats())).toBe(true);
    expect(anymatch(ignoredMatchers, `${nestedSymlink}/deep/file.md`)).toBe(true);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ failedTopLevelEnumeration: false }),
      'Workspace watcher: excluding nested cloud/unclassifiable symlink target from watch',
    );
  });

  it('FAILS CLOSED: excludes a symlink whose readlink throws (dead-mount / unreadable link)', () => {
    const workspace = '/fake/workspace';
    const deadSymlink = `${workspace}/Projects/WedgedLink`;

    readdirSyncMock.mockReturnValue([
      { name: 'Projects', isSymbolicLink: () => false },
    ]);
    // readlink on the symlink throws a NON-EINVAL error (e.g. the link inode is
    // on an unhealthy fs, or ENOENT race) → we cannot prove it is local.
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p === deadSymlink) {
        const err = new Error('ETIMEDOUT: operation timed out, readlink') as NodeJS.ErrnoException;
        err.code = 'ETIMEDOUT';
        throw err;
      }
      throw makeEinval();
    });

    workspaceWatcherService.start(workspace);
    const ignoredMatchers = getIgnoredMatchers();

    // Fail closed: an unclassifiable symlink is EXCLUDED, not followed.
    expect(matchWithStats(ignoredMatchers, deadSymlink, symlinkStats())).toBe(true);
    expect(anymatch(ignoredMatchers, `${deadSymlink}/sub/file.md`)).toBe(true);
  });

  it('FAILS CLOSED on top-level enumeration error but keeps the nested classifier active', () => {
    const workspace = '/fake/workspace';
    const nestedSymlink = `${workspace}/Projects/DriveLink`;
    const cloudTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/X';

    // Top-level readdir throws (the dead mount can wedge enumeration itself).
    // Pre-fix this returned null → NO cloud exclusion at all (failed OPEN).
    readdirSyncMock.mockImplementation(() => {
      const err = new Error('EIO: i/o error, scandir') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p === nestedSymlink) return cloudTarget;
      throw makeEinval();
    });
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);
    const ignoredMatchers = getIgnoredMatchers();

    // The nested classifier is STILL active and excludes the cloud symlink.
    expect(matchWithStats(ignoredMatchers, nestedSymlink, symlinkStats())).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ directory: expect.any(String) }),
      'Workspace watcher: failed to enumerate top-level entries for cloud-symlink exclusion (failing closed — symlinks we cannot classify will be excluded)',
    );
  });

  it('follows a CHAINED local→cloud symlink (checks the cloud pattern at every hop, F1)', () => {
    const workspace = '/fake/workspace';
    const chainedSymlink = `${workspace}/DriveAlias`;
    const intermediateLocal = '/Users/test/DriveAlias'; // a LOCAL alias…
    const cloudTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/Y'; // …that points at Drive

    readdirSyncMock.mockReturnValue([
      { name: 'DriveAlias', isSymbolicLink: () => true },
    ]);
    // Hop 1: symlink → /Users/test/DriveAlias (NON-cloud absolute — would fool a
    // naive "first target is local ⇒ safe" check). Hop 2: that alias → Drive.
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p === chainedSymlink) return intermediateLocal;
      if (p === intermediateLocal) return cloudTarget;
      throw makeEinval();
    });
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);
    const ignoredMatchers = getIgnoredMatchers();

    // The first hop was local, but the chain bottoms out at Drive → EXCLUDED.
    expect(anymatch(ignoredMatchers, chainedSymlink)).toBe(true);
  });

  it('does NOT touch realpath/stat — only readlink — when classifying symlinks', () => {
    const workspace = '/fake/workspace';
    const cloudTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/Z';
    readdirSyncMock.mockReturnValue([
      { name: 'Company Memories', isSymbolicLink: () => true },
    ]);
    readlinkSyncMock.mockImplementation((p: string) =>
      p.endsWith('Company Memories') ? cloudTarget : (() => { throw makeEinval(); })(),
    );
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);
    const ignoredMatchers = getIgnoredMatchers();
    expect(anymatch(ignoredMatchers, `${workspace}/Company Memories`)).toBe(true);
    // The classifier used readlink, never realpath (realpath would block on the
    // dead mount — it is not even imported by the SUT anymore).
    expect(readlinkSyncMock).toHaveBeenCalled();
  });

  it('excludes a Windows G:\\ drive-letter cloud symlink and its child (RC-1 refinement)', async () => {
    // Reproduce Windows on the POSIX CI host: path.join yields backslashes.
    // Pre-fix this used forward-slash GLOBS; picomatch/anymatch treat backslashes
    // as escapes, so a `G:\My Drive\…` glob never matched → the Windows cloud
    // providers (G:\My Drive, OneDrive, C:\Users\…\Google Drive) stayed
    // un-excluded and the watcher kept hanging. The function matcher sidesteps
    // glob escaping entirely. anymatch is used directly here, mirroring how
    // chokidar feeds the matcher (it normalizes the candidate first).
    const pathMod = await vi.importActual<typeof import('node:path')>('node:path');
    joinImplRef.current = (...parts: string[]) => pathMod.win32.join(...parts);

    const workspace = 'C:\\Users\\test\\Documents\\Mindstone Rebel';
    const cloudTarget = 'G:\\My Drive\\Company Memories';

    readdirSyncMock.mockReturnValue([
      { name: 'Company Memories', isSymbolicLink: () => true },
    ]);
    readlinkSyncMock.mockImplementation((p: string) =>
      p.endsWith('Company Memories') ? cloudTarget : (() => { throw makeEinval(); })(),
    );
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);

    const ignoredMatchers = getIgnoredMatchers();
    // The symlink is at C:\Users\test\Documents\Mindstone Rebel\Company Memories.
    // chokidar normalizes the paths it TESTS to forward slashes, so assert against
    // the normalized symlink and child paths.
    const symlinkPath = 'C:/Users/test/Documents/Mindstone Rebel/Company Memories';
    const childPath = 'C:/Users/test/Documents/Mindstone Rebel/Company Memories/sub/file.md';
    expect(anymatch(ignoredMatchers, symlinkPath)).toBe(true);
    expect(anymatch(ignoredMatchers, childPath)).toBe(true);

    // A sibling whose name is a string-prefix of the cloud symlink must NOT be
    // excluded — the matcher anchors on a path-segment boundary.
    const siblingPath = 'C:/Users/test/Documents/Mindstone Rebel/Company Memories Backup/file.md';
    expect(anymatch(ignoredMatchers, siblingPath)).toBe(false);
  });

  it('excludes a cloud symlink under a UNC \\\\server\\share workspace root and its child (RC-1 F1 — UNC normalization)', async () => {
    // Windows network-share workspace root. path.win32.join yields a UNC SYMLINK
    // path with real backslashes (\\server\share\workspace\Company Memories). The
    // earlier glob fix portablised that path via toPortablePath →
    // `//server/share/…` (TWO leading slashes), but anymatch's normalize-path
    // collapses the CANDIDATE it tests to `/server/share/…` (ONE leading slash) →
    // the glob was out of phase and a cloud symlink under a UNC root was still
    // traversed (the watcher hang). The function matcher normalizes BOTH the
    // precomputed symlink root and the candidate through the same helper, so UNC
    // is robust. RED before the fix (anymatch returns false on the `//server`
    // glob), GREEN after.
    const pathMod = await vi.importActual<typeof import('node:path')>('node:path');
    joinImplRef.current = (...parts: string[]) => pathMod.win32.join(...parts);

    const workspace = '\\\\server\\share\\workspace';
    const cloudTarget = '\\\\fileserver\\jane\\cloud\\Company Memories';

    readdirSyncMock.mockReturnValue([
      { name: 'Company Memories', isSymbolicLink: () => true },
    ]);
    readlinkSyncMock.mockImplementation((p: string) =>
      p.endsWith('Company Memories') ? cloudTarget : (() => { throw makeEinval(); })(),
    );
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'onedrive' } : { isCloud: false },
    );

    workspaceWatcherService.start(workspace);

    const ignoredMatchers = getIgnoredMatchers();
    // chokidar's normalize-path collapses the UNC candidate to a single leading
    // slash; assert against that canonical form (the matcher re-normalizes raw
    // input too, but anymatch hands it the normalized candidate).
    const symlinkPath = '/server/share/workspace/Company Memories';
    const childPath = '/server/share/workspace/Company Memories/sub/file.md';
    expect(anymatch(ignoredMatchers, symlinkPath)).toBe(true);
    expect(anymatch(ignoredMatchers, childPath)).toBe(true);

    // A UNC sibling that is a string-prefix of the symlink must NOT be excluded.
    const siblingPath = '/server/share/workspace/Company Memories Backup/file.md';
    expect(anymatch(ignoredMatchers, siblingPath)).toBe(false);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ entryName: 'Company Memories' }),
      'Workspace watcher: excluding cloud/unclassifiable top-level symlink target from watch',
    );
  });

  it.each([
    {
      label: 'extended-length drive \\\\?\\C:\\',
      workspace: '\\\\?\\C:\\workspace',
      symlinkRaw: '\\\\?\\C:\\workspace\\Company Memories',
      childRaw: '\\\\?\\C:\\workspace\\Company Memories\\sub\\file.md',
      siblingRaw: '\\\\?\\C:\\workspace\\Company Memories Backup\\file.md',
    },
    {
      label: 'extended-length UNC \\\\?\\UNC\\server\\share',
      workspace: '\\\\?\\UNC\\server\\share\\workspace',
      symlinkRaw: '\\\\?\\UNC\\server\\share\\workspace\\Company Memories',
      childRaw: '\\\\?\\UNC\\server\\share\\workspace\\Company Memories\\sub\\file.md',
      siblingRaw: '\\\\?\\UNC\\server\\share\\workspace\\Company Memories Backup\\x',
    },
    {
      label: 'device namespace \\\\.\\C:\\',
      workspace: '\\\\.\\C:\\workspace',
      symlinkRaw: '\\\\.\\C:\\workspace\\Company Memories',
      childRaw: '\\\\.\\C:\\workspace\\Company Memories\\sub\\file.md',
      siblingRaw: '\\\\.\\C:\\workspace\\Company Memories Backup',
    },
  ])(
    'excludes a cloud symlink under a Windows device-namespace workspace root: $label (RC-1 F1 — idempotent normalization)',
    async ({ workspace, symlinkRaw, childRaw, siblingRaw }) => {
      // The win32 device-namespace prefixes (\\?\, \\?\UNC\, \\.\) are the same
      // double-slash-collapse class as plain UNC, but ONE level deeper: anymatch
      // hands the function matcher a candidate it has ALREADY run through
      // normalize-path, which turns `\\?\C:\…` into `//?/C:/…`. normalize-path is
      // NOT idempotent on these prefixes (it only preserves `//` when it sees
      // BACKSLASHES), so a naive second normalization inside the matcher would
      // collapse `//?/` → `/?/` for the candidate while the precomputed root —
      // built from the raw backslash path — stays `//?/`. Out of phase → the
      // cloud symlink would still be traversed. normalizeWatchPath detects the
      // device-namespace prefix on either slash flavour, so both sides land on
      // `//?/…` / `//./…`. RED before the idempotency fix, GREEN after.
      //
      // We drive anymatch with the RAW backslash candidate (exactly what chokidar
      // passes — index.js feeds _userIgnored the OS-native path), so anymatch's
      // own normalize-path runs first, reproducing the real round-trip.
      const pathMod = await vi.importActual<typeof import('node:path')>('node:path');
      joinImplRef.current = (...parts: string[]) => pathMod.win32.join(...parts);

      const cloudTarget = '\\\\fileserver\\jane\\cloud\\Company Memories';

      readdirSyncMock.mockReturnValue([
        { name: 'Company Memories', isSymbolicLink: () => true },
      ]);
      readlinkSyncMock.mockImplementation((p: string) =>
        p.endsWith('Company Memories') ? cloudTarget : (() => { throw makeEinval(); })(),
      );
      detectCloudStorageMock.mockImplementation((p: string) =>
        p === cloudTarget ? { isCloud: true, provider: 'onedrive' } : { isCloud: false },
      );

      workspaceWatcherService.start(workspace);

      const ignoredMatchers = getIgnoredMatchers();
      // Sanity: the symlink path the SUT precomputed matches what we're testing.
      expect(pathMod.win32.join(workspace, 'Company Memories')).toBe(symlinkRaw);

      // anymatch normalizes the raw backslash candidate first, then calls our
      // function matcher — the real chokidar round-trip.
      expect(anymatch(ignoredMatchers, symlinkRaw)).toBe(true);
      expect(anymatch(ignoredMatchers, childRaw)).toBe(true);
      // Segment-boundary sibling must NOT be excluded.
      expect(anymatch(ignoredMatchers, siblingRaw)).toBe(false);
    },
  );
});

describe('workspaceWatcherService — cloud-mount workspace ROOT (Stage 4b statSync-root edge)', () => {
  const CLOUD_ROOT =
    '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/My Workspace';

  beforeEach(() => {
    currentWatcher = null;
    vi.clearAllMocks();
    readdirSyncMock.mockReturnValue([]);
    readlinkSyncMock.mockImplementation(() => {
      throw makeEinval();
    });
    detectCloudStorageMock.mockReturnValue({ isCloud: false });
    detectInPlaceCloudDocumentsMock.mockReturnValue(false);
    getTimeoutForPathMock.mockReturnValue(5000);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    statAsyncMock.mockResolvedValue({ isDirectory: () => true });
    joinImplRef.current = null;
    workspaceWatcherService.removeAllListeners();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await workspaceWatcherService.stop();
    workspaceWatcherService.removeAllListeners();
  });

  it('a DEAD cloud-mount ROOT does not block start(): no synchronous statSync, validation goes off to the bounded async path', async () => {
    // The regression this closes: a synchronous statSync(directory) on a dead
    // Google Drive FUSE root blocks in the kernel with no timeout, parking a
    // libuv pool thread. detectCloudStorage marks the root as cloud, so start()
    // must take the bounded ASYNC path and NEVER call the synchronous statSync.
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    // Simulate a dead mount: the async stat never resolves. start() must return
    // synchronously regardless (it does not await this).
    statAsyncMock.mockReturnValue(new Promise<never>(() => {}));

    expect(() => workspaceWatcherService.start(CLOUD_ROOT)).not.toThrow();

    // The blocking synchronous statSync must NEVER be called for a cloud root —
    // synchronously OR after microtasks flush (this is the whole point).
    expect(statSyncMock).not.toHaveBeenCalled();
    // The bounded async validate was dispatched instead (on a microtask, via
    // runWithTimeout's Promise.resolve().then(work)).
    await vi.waitFor(() => {
      expect(statAsyncMock).toHaveBeenCalledWith(CLOUD_ROOT);
    });
    expect(statSyncMock).not.toHaveBeenCalled();
    // No watcher installed yet (validation hasn't resolved).
    expect(watch).not.toHaveBeenCalled();
  });

  it('in-place iCloud Documents/Desktop ROOT (xattr signal) also takes the async path, not synchronous statSync', async () => {
    // detectCloudStorage intentionally returns isCloud:false for ~/Documents,
    // but detectInPlaceCloudDocuments (file-provider-domain-id xattr) flags it.
    detectCloudStorageMock.mockReturnValue({ isCloud: false });
    detectInPlaceCloudDocumentsMock.mockReturnValue(true);
    statAsyncMock.mockReturnValue(new Promise<never>(() => {}));

    workspaceWatcherService.start('/Users/test/Documents/My Notes');

    expect(statSyncMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(statAsyncMock).toHaveBeenCalledWith('/Users/test/Documents/My Notes');
    });
    expect(statSyncMock).not.toHaveBeenCalled();
  });

  it('a HEALTHY cloud-mount ROOT installs the watcher once the bounded async stat resolves', async () => {
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    statAsyncMock.mockResolvedValue({ isDirectory: () => true });

    workspaceWatcherService.start(CLOUD_ROOT);
    // Let the fire-and-forget async validation settle.
    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledTimes(1);
    });
    expect(watch).toHaveBeenCalledWith(CLOUD_ROOT, expect.any(Object));
  });

  it('a DEAD cloud ROOT defers the watch with an observable warn and schedules a bounded retry; a reconnect installs it', async () => {
    vi.useFakeTimers();
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    // First validate: dead (times out). Second validate (retry): healthy.
    let call = 0;
    statAsyncMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise<never>(() => {}); // never resolves → timeout
      return Promise.resolve({ isDirectory: () => true });
    });

    workspaceWatcherService.start(CLOUD_ROOT);

    // Advance past the bounded cloud-root stat timeout (15s) so the validate times out.
    await vi.advanceTimersByTimeAsync(15_001);

    // Deferred: observable warn fired, no watcher installed yet.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ directory: CLOUD_ROOT }),
      expect.stringContaining('deferred'),
    );
    expect(watch).not.toHaveBeenCalled();

    // Advance past the retry interval (60s); the retry re-drives start() and the
    // now-healthy mount installs the watch.
    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledTimes(1);
    });
  });

  it('LOCAL root still uses the cheap synchronous statSync (no async-path regression)', () => {
    detectCloudStorageMock.mockReturnValue({ isCloud: false });
    detectInPlaceCloudDocumentsMock.mockReturnValue(false);
    statSyncMock.mockReturnValue({ isDirectory: () => true });

    workspaceWatcherService.start('/fake/local-workspace');

    expect(statSyncMock).toHaveBeenCalledWith('/fake/local-workspace');
    expect(statAsyncMock).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('installing a HEALTHY cloud ROOT does NOT synchronously readdir the (possibly dead) mount (F1)', async () => {
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    statAsyncMock.mockResolvedValue({ isDirectory: () => true });
    // readdirSync would block on a dead Drive mount; the install path must skip
    // the Tier-1 top-level precompute for a cloud root.
    readdirSyncMock.mockClear();

    workspaceWatcherService.start(CLOUD_ROOT);
    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledTimes(1);
    });
    // The synchronous top-level enumeration of the cloud root must NOT have run.
    expect(readdirSyncMock).not.toHaveBeenCalledWith(CLOUD_ROOT, expect.anything());
  });

  it('dedupes repeated start() of the same cloud ROOT while a validation is in flight (F3 — one stat, not N)', async () => {
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    // Dead mount: never resolves, so the validation stays in flight.
    statAsyncMock.mockReturnValue(new Promise<never>(() => {}));

    workspaceWatcherService.start(CLOUD_ROOT);
    await vi.waitFor(() => {
      expect(statAsyncMock).toHaveBeenCalledTimes(1);
    });
    // Re-driving the same directory must NOT launch another stat probe.
    workspaceWatcherService.start(CLOUD_ROOT);
    workspaceWatcherService.start(CLOUD_ROOT);
    // Give any (wrongly-dispatched) extra validations a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(statAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes start(sameCloudRoot) during the retry COOLDOWN after a timeout (F3 — no extra stat while the abandoned one may be parked)', async () => {
    vi.useFakeTimers();
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    // Dead mount: never resolves → first validate times out, scheduling a retry.
    statAsyncMock.mockReturnValue(new Promise<never>(() => {}));

    workspaceWatcherService.start(CLOUD_ROOT);
    // Time out the first bounded validate (15s).
    await vi.advanceTimersByTimeAsync(15_001);
    expect(statAsyncMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ directory: CLOUD_ROOT }),
      expect.stringContaining('deferred'),
    );

    // Now, DURING the 60s cooldown (before the retry fires), a same-root start()
    // must be deduped — it must NOT launch another abandoned stat.
    workspaceWatcherService.start(CLOUD_ROOT);
    await Promise.resolve();
    expect(statAsyncMock).toHaveBeenCalledTimes(1);

    // When the retry fires, the marker is cleared and exactly one new stat runs.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(statAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('stop() during a cloud cooldown lets a later same-dir start() proceed (no permanent dedupe lock)', async () => {
    vi.useFakeTimers();
    detectCloudStorageMock.mockReturnValue({ isCloud: true, provider: 'google_drive' });
    statAsyncMock.mockReturnValue(new Promise<never>(() => {}));

    workspaceWatcherService.start(CLOUD_ROOT);
    await vi.advanceTimersByTimeAsync(15_001); // time out → cooldown marker + retry
    expect(statAsyncMock).toHaveBeenCalledTimes(1);

    // Explicit teardown clears the cooldown marker + cancels the retry.
    await workspaceWatcherService.stop();

    // A fresh same-dir start() must NOT be wrongly deduped (the marker is gone).
    workspaceWatcherService.start(CLOUD_ROOT);
    await Promise.resolve();
    expect(statAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('a late cloud-A validation does NOT clobber a watcher installed for a different root B (F2 supersede)', async () => {
    // start(A) cloud: validation in flight (resolves LATER).
    let resolveA: (v: { isDirectory: () => boolean }) => void = () => {};
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === '/cloud/A' ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );
    statAsyncMock.mockReturnValue(
      new Promise<{ isDirectory: () => boolean }>((res) => {
        resolveA = res;
      }),
    );

    workspaceWatcherService.start('/cloud/A');
    await vi.waitFor(() => {
      expect(statAsyncMock).toHaveBeenCalledWith('/cloud/A');
    });

    // Now start(B) — a LOCAL root — installs synchronously.
    workspaceWatcherService.start('/local/B');
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenLastCalledWith('/local/B', expect.any(Object));
    const callsAfterB = (watch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    // A's stat finally resolves — its generation is now stale, so it must NOT
    // install (no second watch() call, no clobber of B).
    resolveA({ isDirectory: () => true });
    await Promise.resolve();
    await Promise.resolve();
    expect((watch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterB);
    expect(workspaceWatcherService.getCurrentDirectory()).toBe('/local/B');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// S4.2 (260619_cloud-symlink-indexing) — cloud symlinks are ALWAYS EXCLUDED from the
// live chokidar watch. The Stage-6b live-watch admission override (admit a healthy
// cloud subtree) + the restartCurrent() de-admission reinstall are RETIRED (DROP-3):
// a dead admitted mount's internal lstat/readdir parked libuv workers, and the
// boundary + periodic re-walk keep a healthy cloud space indexed without live-watching
// it. So even with the admission flag ON + a HEALTHY verdict, a cloud symlink stays
// excluded from the watch.
// ───────────────────────────────────────────────────────────────────────────
describe('workspaceWatcherService — S4.2 cloud exclusion (DROP-3: no live-watch admission)', () => {
  const workspace = '/fake/workspace';
  const cloudTarget =
    '/Users/test/Library/CloudStorage/GoogleDrive-user/Shared drives/Company Memories';
  let verdict: 'healthy' | 'degraded' | 'unknown';

  beforeEach(() => {
    currentWatcher = null;
    vi.clearAllMocks();
    verdict = 'healthy';
    // One top-level cloud symlink: `Company Memories -> cloudTarget`.
    readdirSyncMock.mockReturnValue([
      { name: 'Company Memories', isSymbolicLink: () => true },
    ]);
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('Company Memories')) return cloudTarget;
      throw makeEinval();
    });
    detectCloudStorageMock.mockImplementation((p: string) =>
      p === cloudTarget ? { isCloud: true, provider: 'google_drive' } : { isCloud: false },
    );
    // Admission ON + healthy verdict — the previously-admitting scenario — yet cloud
    // must STILL be excluded (DROP-3).
    setCloudSymlinkIndexingEnabled(true);
    setCloudLivenessProbe({
      probeHealth: async () => verdict,
      getCachedVerdict: () => verdict,
    });
    workspaceWatcherService.removeAllListeners();
  });

  afterEach(async () => {
    await workspaceWatcherService.stop();
    workspaceWatcherService.removeAllListeners();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    joinImplRef.current = null;
  });

  it('EXCLUDES a cloud symlink even with the admission flag ON + a HEALTHY verdict (DROP-3)', () => {
    workspaceWatcherService.start(workspace);
    const ignoredMatchers = getIgnoredMatchers();
    // The live-watch admission override is gone, so a cloud symlink + its subtree are
    // ALWAYS excluded from the chokidar watch, regardless of flag/verdict.
    expect(anymatch(ignoredMatchers, `${workspace}/Company Memories`)).toBe(true);
    expect(anymatch(ignoredMatchers, `${workspace}/Company Memories/sub/file.md`)).toBe(true);
  });
});
